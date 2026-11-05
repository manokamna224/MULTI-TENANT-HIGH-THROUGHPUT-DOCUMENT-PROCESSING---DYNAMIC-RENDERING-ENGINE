package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/docengine/ingestion/internal/api"
	"go.uber.org/zap"
)

func TestRequestID_GeneratesUUID(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(api.RequestID())
	r.GET("/", func(c *gin.Context) { c.Status(http.StatusOK) })

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w   := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	rid := w.Header().Get("X-Request-ID")
	if rid == "" {
		t.Error("X-Request-ID header must be set by the middleware")
	}
	// UUID format is 36 chars: 8-4-4-4-12
	if len(rid) != 36 {
		t.Errorf("X-Request-ID must be 36 chars (UUID format), got %d: %s", len(rid), rid)
	}
}

func TestRequestID_PreservesIncomingID(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(api.RequestID())
	r.GET("/", func(c *gin.Context) { c.Status(http.StatusOK) })

	incoming := "my-custom-request-id"
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Request-ID", incoming)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if got := w.Header().Get("X-Request-ID"); got != incoming {
		t.Errorf("want %q, got %q", incoming, got)
	}
}

func TestTenantFromHeader_SetsContext(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(api.TenantFromHeader())

	var capturedTenantID string
	r.GET("/", func(c *gin.Context) {
		capturedTenantID = c.GetString("tenant_id")
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Tenant-ID", "tenant-xyz")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if capturedTenantID != "tenant-xyz" {
		t.Errorf("expected tenant_id=tenant-xyz in context, got %q", capturedTenantID)
	}
}

func TestTenantFromHeader_NoHeader_DoesNotSet(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(api.TenantFromHeader())

	var capturedTenantID string
	r.GET("/", func(c *gin.Context) {
		capturedTenantID = c.GetString("tenant_id")
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w   := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if capturedTenantID != "" {
		t.Errorf("expected empty tenant_id when header absent, got %q", capturedTenantID)
	}
}

func TestRecovery_CatchesPanic(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)

	logger, _ := zap.NewDevelopment()
	r := gin.New()
	r.Use(api.RequestID())
	r.Use(api.Recovery(logger))
	r.GET("/panic", func(_ *gin.Context) { panic("test panic") })

	req := httptest.NewRequest(http.MethodGet, "/panic", nil)
	w   := httptest.NewRecorder()

	// Must NOT panic at the test level — Recovery should catch it
	r.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 after panic recovery, got %d", w.Code)
	}
}
