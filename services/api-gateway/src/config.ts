export class Config {
  readonly port:            number;
  readonly upstreamUrl:     string;   // ingestion-engine base URL
  readonly databaseUrl:     string;
  readonly redisUrl:        string;
  readonly jwtSecret:       string;
  /** Global rate limit: max requests per window per tenant. */
  readonly rateLimitMax:    number;
  readonly rateLimitWindowMs: number;

  private constructor(env: NodeJS.ProcessEnv) {
    this.port               = parseInt(env.PORT ?? '3000', 10);
    this.upstreamUrl        = this.req(env, 'UPSTREAM_URL');
    this.databaseUrl        = this.req(env, 'DATABASE_URL');
    this.redisUrl           = this.req(env, 'REDIS_URL');
    this.jwtSecret          = this.req(env, 'JWT_SECRET');
    this.rateLimitMax       = parseInt(env.RATE_LIMIT_MAX ?? '100', 10);
    this.rateLimitWindowMs  = parseInt(env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);
  }

  static fromEnv(): Config { return new Config(process.env); }

  private req(env: NodeJS.ProcessEnv, key: string): string {
    const v = env[key];
    if (!v) throw new Error(`Required env var ${key} not set`);
    return v;
  }
}
