package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/docengine/ingestion/internal/api"
	"github.com/yourorg/docengine/ingestion/internal/queue"
	"github.com/yourorg/docengine/ingestion/internal/repository"
	"github.com/yourorg/docengine/ingestion/internal/validation"
	"go.uber.org/zap"
)

func main() {
	logger, err := zap.NewProduction()
	if err != nil {
		log.Fatalf("failed to initialize logger: %v", err)
	}
	defer logger.Sync() //nolint:errcheck

	ctx := context.Background()

	// ── Redis publisher (with startup retry) ─────────────────────────────────
	redisURL := envOr("REDIS_URL", "redis://localhost:6379")
	var publisher *queue.RedisPublisher
	if err := retry(ctx, 5, 2*time.Second, "redis", func() error {
		var e error
		publisher, e = queue.NewRedisPublisher(redisURL)
		return e
	}); err != nil {
		logger.Fatal("redis unavailable after retries", zap.Error(err))
	}
	defer publisher.Close()

	// ── Database repository (with startup retry) ──────────────────────────────
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		logger.Fatal("DATABASE_URL is required")
	}
	var repo *repository.JobRepository
	if err := retry(ctx, 10, 2*time.Second, "postgres", func() error {
		var e error
		repo, e = repository.New(ctx, databaseURL)
		return e
	}); err != nil {
		logger.Fatal("database unavailable after retries", zap.Error(err))
	}
	defer repo.Close()

	// ── Schema validator ──────────────────────────────────────────────────────
	validator, err := validation.New()
	if err != nil {
		logger.Fatal("failed to load JSON schemas", zap.Error(err))
	}
	logger.Info("schemas loaded", zap.Strings("types", validator.KnownDocTypes()))

	// ── Stream retry sweeper (re-publishes jobs stuck in DB) ──────────────────
	sweeper := queue.NewRetrySweeper(repo.Pool(), publisher, logger)
	sweepCtx, sweepCancel := context.WithCancel(ctx)
	defer sweepCancel()
	go sweeper.Run(sweepCtx)

	// ── HTTP server ───────────────────────────────────────────────────────────
	if envOr("GIN_MODE", "debug") == "release" {
		gin.SetMode(gin.ReleaseMode)
	}

	// gin.New() — middleware registered inside handler.RegisterRoutes (structured versions)
	router := gin.New()

	handler := api.NewHandler(logger, publisher, repo, validator)
	handler.RegisterRoutes(router)

	srv := &http.Server{
		Addr:         ":" + envOr("PORT", "8080"),
		Handler:      router,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		logger.Info("ingestion engine listening", zap.String("addr", srv.Addr))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatal("server error", zap.Error(err))
		}
	}()

	// ── Graceful shutdown ─────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	logger.Info("shutdown signal received")

	shutdownCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("server shutdown error", zap.Error(err))
	}
	logger.Info("ingestion engine stopped")
}

// retry calls fn up to maxAttempts times, sleeping backoff between failures.
func retry(ctx context.Context, maxAttempts int, backoff time.Duration, name string, fn func() error) error {
	for i := 1; i <= maxAttempts; i++ {
		if err := fn(); err == nil {
			return nil
		} else if i == maxAttempts {
			return err
		} else {
			log.Printf("[%s] attempt %d/%d failed, retrying in %s: %v", name, i, maxAttempts, backoff, err)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
				backoff = min(backoff*2, 30*time.Second)
			}
		}
	}
	return nil
}

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
