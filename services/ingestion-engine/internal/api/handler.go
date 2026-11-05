// Package api exposes the HTTP ingestion surface.
//
//	POST /v1/render    — validates payload, runs math verification, enqueues render job
//	GET  /v1/jobs/:id  — returns job status from the repository
//	GET  /v1/healthz   — liveness check
package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/yourorg/docengine/ingestion/internal/math"
	"github.com/yourorg/docengine/ingestion/internal/queue"
	"github.com/yourorg/docengine/ingestion/internal/repository"
	"github.com/yourorg/docengine/ingestion/internal/validation"
	"go.uber.org/zap"
)

// RenderRequest is the inbound payload from callers.
type RenderRequest struct {
	TenantID     string          `json:"tenant_id"     binding:"required,uuid"`
	TemplateID   string          `json:"template_id"   binding:"required,uuid"`
	DocumentType string          `json:"document_type" binding:"required"`
	Payload      json.RawMessage `json:"payload"       binding:"required"`
}

// Handler holds dependencies for all API endpoints.
type Handler struct {
	log       *zap.Logger
	publisher *queue.RedisPublisher
	repo      *repository.JobRepository
	validator *validation.Validator
}

// NewHandler constructs a Handler with all dependencies injected.
func NewHandler(
	log *zap.Logger,
	publisher *queue.RedisPublisher,
	repo *repository.JobRepository,
	validator *validation.Validator,
) *Handler {
	return &Handler{
		log:       log,
		publisher: publisher,
		repo:      repo,
		validator: validator,
	}
}

// RegisterRoutes attaches all routes to the provided engine.
func (h *Handler) RegisterRoutes(r *gin.Engine) {
	r.Use(RequestID())
	r.Use(Logger(h.log))
	r.Use(TenantFromHeader())
	r.Use(Recovery(h.log))

	v1 := r.Group("/v1")
	{
		v1.POST("/render",    h.handleRender)
		v1.GET("/jobs",       h.handleListJobs)
		v1.GET("/jobs/:id",   h.handleJobStatus)
		v1.GET("/healthz",    h.handleHealth)
	}
}

// handleRender is the main ingestion endpoint.
//
// Pipeline:
//  1. Bind + basic struct validation (gin binding)
//  2. JSON Schema validation per document_type
//  3. Decimal arithmetic reconciliation for financial documents
//  4. Insert pending row into render_jobs (idempotency key = job_id)
//  5. Publish to Redis Stream
func (h *Handler) handleRender(c *gin.Context) {
	var req RenderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request", "detail": err.Error()})
		return
	}

	// Step 2: JSON Schema validation
	if err := h.validator.Validate(req.DocumentType, req.Payload); err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{
			"error":  "schema_validation_failed",
			"detail": err.Error(),
		})
		return
	}

	// Step 3: Decimal arithmetic reconciliation (financial docs only)
	if isMathDocument(req.DocumentType) {
		if rejectMsg := verifyMath(req.Payload); rejectMsg != nil {
			c.JSON(http.StatusUnprocessableEntity, rejectMsg)
			return
		}
	}

	// Step 4: Create the job record before publishing — ensures we can always
	// look up a job_id even if the Redis publish succeeds but the DB write doesn't.
	jobID := uuid.New().String()
	if err := h.repo.CreateJob(c.Request.Context(), repository.CreateJobParams{
		JobID:        jobID,
		TenantID:     req.TenantID,
		TemplateID:   req.TemplateID,
		DocumentType: req.DocumentType,
		Payload:      req.Payload,
	}); err != nil {
		h.log.Error("failed to create job record", zap.String("job_id", jobID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database_unavailable"})
		return
	}

	// Step 5: Publish to Redis Stream
	job := queue.RenderJob{
		JobID:        jobID,
		TenantID:     req.TenantID,
		TemplateID:   req.TemplateID,
		DocumentType: req.DocumentType,
		Payload:      req.Payload,
		EnqueuedAt:   time.Now().UTC(),
	}
	if err := h.publisher.Publish(c.Request.Context(), job); err != nil {
		h.log.Error("failed to enqueue job", zap.String("job_id", jobID), zap.Error(err))
		// Job row exists as 'queued' — a background reaper can retry publishing.
		c.JSON(http.StatusAccepted, gin.H{
			"job_id":   jobID,
			"status":   "queued",
			"warning":  "queued to database; stream publish failed — will retry",
		})
		return
	}

	h.log.Info("render job queued",
		zap.String("job_id", jobID),
		zap.String("tenant_id", req.TenantID),
		zap.String("document_type", req.DocumentType),
	)

	c.JSON(http.StatusAccepted, gin.H{
		"job_id":  jobID,
		"status":  "queued",
	})
}

func (h *Handler) handleJobStatus(c *gin.Context) {
	jobID := c.Param("id")
	if _, err := uuid.Parse(jobID); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_job_id"})
		return
	}

	job, err := h.repo.GetJob(c.Request.Context(), jobID)
	if err != nil {
		if err == repository.ErrNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "job_not_found"})
			return
		}
		h.log.Error("job lookup failed", zap.String("job_id", jobID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database_error"})
		return
	}

	c.JSON(http.StatusOK, job)
}

func (h *Handler) handleListJobs(c *gin.Context) {
	// Tenant ID comes from the gateway header (preferred) or query param (direct calls)
	tenantID := c.GetString("tenant_id")
	if tenantID == "" {
		tenantID = c.Query("tenant_id")
	}
	if tenantID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "tenant_id required"})
		return
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tenant_id"})
		return
	}

	limit  := 20
	offset := 0
	if l := c.Query("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil {
			limit = v
		}
	}
	if o := c.Query("offset"); o != "" {
		if v, err := strconv.Atoi(o); err == nil {
			offset = v
		}
	}
	if limit  < 1   { limit  = 1   }
	if limit  > 100 { limit  = 100 }
	if offset < 0   { offset = 0   }

	jobs, err := h.repo.ListJobsByTenant(c.Request.Context(), tenantID, limit, offset)
	if err != nil {
		h.log.Error("listing jobs failed", zap.String("tenant_id", tenantID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database_error"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"jobs":   jobs,
		"limit":  limit,
		"offset": offset,
		"count":  len(jobs),
	})
}

func (h *Handler) handleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "ingestion-engine"})
}

// ── Math verification helpers ─────────────────────────────────────────────────

// mathPayload is the minimal overlay needed for financial arithmetic checks.
// All monetary values arrive as decimal strings to avoid float64 representation issues.
type mathPayload struct {
	LineItems          []math.LineItem `json:"line_items"`
	Summary struct {
		Subtotal           decimal.Decimal `json:"subtotal"`
		TaxRatePct         decimal.Decimal `json:"tax_rate_pct"`
		TaxAmount          decimal.Decimal `json:"tax_amount"`
		GrandTotal         decimal.Decimal `json:"grand_total"`
		ContractValue      decimal.Decimal `json:"contract_value"`
		PreviousCumulative decimal.Decimal `json:"previous_cumulative"`
		CurrentClaim       decimal.Decimal `json:"current_claim"`
	} `json:"summary"`
}

// verifyMath returns a gin-compatible error map on failure, nil on success.
func verifyMath(raw json.RawMessage) gin.H {
	var doc mathPayload
	if err := json.Unmarshal(raw, &doc); err != nil {
		return gin.H{"error": "payload_parse_error", "detail": err.Error()}
	}

	// Line-item reconciliation
	if lineErrs := math.VerifyLineItems(doc.LineItems); len(lineErrs) > 0 {
		details := make([]string, len(lineErrs))
		for i, e := range lineErrs {
			details[i] = e.Error()
		}
		return gin.H{"error": "arithmetic_reconciliation_failed", "details": details}
	}

	// Subtotal = sum of amounts
	computed := math.ComputeSubtotal(doc.LineItems)
	if !computed.Equal(doc.Summary.Subtotal) {
		return gin.H{
			"error":    "subtotal_mismatch",
			"expected": computed.String(),
			"got":      doc.Summary.Subtotal.String(),
		}
	}

	// Cumulative billing ceiling check
	if err := math.CumulativeBillingCheck(
		doc.Summary.ContractValue,
		doc.Summary.PreviousCumulative,
		doc.Summary.CurrentClaim,
	); err != nil {
		return gin.H{"error": "cumulative_billing_exceeded", "detail": err.Error()}
	}

	return nil
}

func isMathDocument(docType string) bool {
	switch docType {
	case "measurement_book", "schedule_of_rates", "cumulative_billing":
		return true
	}
	return false
}
