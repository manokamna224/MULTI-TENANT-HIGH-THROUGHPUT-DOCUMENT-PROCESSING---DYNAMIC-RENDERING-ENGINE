package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

// RequestID injects a unique X-Request-ID into every request.
// If the caller supplies one it is preserved; otherwise a new UUID is generated.
// The ID is set on the response header and stored in the Gin context under "request_id".
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		rid := c.GetHeader("X-Request-ID")
		if rid == "" {
			rid = uuid.New().String()
		}
		c.Set("request_id", rid)
		c.Header("X-Request-ID", rid)
		c.Next()
	}
}

// Logger emits a structured access log line for every request using zap.
func Logger(log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start  := time.Now()
		path   := c.Request.URL.Path
		method := c.Request.Method

		c.Next()

		rid, _ := c.Get("request_id")
		ridStr := ""
		if rid != nil {
			ridStr, _ = rid.(string)
		}
		log.Info("request",
			zap.String("method",      method),
			zap.String("path",        path),
			zap.Int("status",         c.Writer.Status()),
			zap.Duration("latency",   time.Since(start)),
			zap.String("client_ip",   c.ClientIP()),
			zap.String("request_id",  ridStr),
			zap.String("tenant_id",   c.GetHeader("X-Tenant-ID")),
		)
	}
}

// TenantFromHeader reads X-Tenant-ID forwarded by the API gateway and stores
// it in the Gin context. Routes that require a tenant can call c.GetString("tenant_id").
// When the ingestion-engine is called directly (bypass gateway) the header is absent
// and the tenant_id from the JSON body is used instead.
func TenantFromHeader() gin.HandlerFunc {
	return func(c *gin.Context) {
		if tid := c.GetHeader("X-Tenant-ID"); tid != "" {
			c.Set("tenant_id", tid)
		}
		c.Next()
	}
}

// Recovery wraps gin.Recovery and adds structured logging of panics.
func Recovery(log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if r := recover(); r != nil {
				rid, _ := c.Get("request_id")
				log.Error("panic recovered",
					zap.Any("panic",      r),
					zap.String("request_id", func() string {
						if rid != nil { return rid.(string) }
						return ""
					}()),
				)
				c.AbortWithStatusJSON(http.StatusInternalServerError,
					gin.H{"error": "internal_server_error"})
			}
		}()
		c.Next()
	}
}
