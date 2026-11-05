module github.com/yourorg/docengine/integration-tests

go 1.22

require (
	github.com/gin-gonic/gin v1.10.0
	github.com/jackc/pgx/v5 v5.7.1
	github.com/redis/go-redis/v9 v9.6.1
	github.com/testcontainers/testcontainers-go v0.34.0
	github.com/testcontainers/testcontainers-go/modules/postgres v0.34.0
	github.com/testcontainers/testcontainers-go/modules/redis v0.34.0
	github.com/yourorg/docengine/ingestion v0.0.0
	go.uber.org/zap v1.27.0
)

replace github.com/yourorg/docengine/ingestion => ../../services/ingestion-engine
