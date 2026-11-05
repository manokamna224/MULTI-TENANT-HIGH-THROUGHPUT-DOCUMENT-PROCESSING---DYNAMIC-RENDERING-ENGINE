export class Config {
  readonly redisUrl:        string;
  readonly consumerGroup:   string;
  readonly consumerName:    string;
  readonly concurrency:     number;
  readonly maxJobsPerWorker: number;
  readonly maxRssMb:        number;
  readonly artifactBucket:  string;
  readonly s3Endpoint?:     string;
  readonly templateDir:     string;

  private constructor(env: NodeJS.ProcessEnv) {
    this.redisUrl         = this.require(env, 'REDIS_URL');
    this.consumerGroup    = env.CONSUMER_GROUP    ?? 'chromium-workers';
    this.consumerName     = env.CONSUMER_NAME     ?? `worker-${process.pid}`;
    this.concurrency      = parseInt(env.WORKER_CONCURRENCY ?? '2', 10);
    this.maxJobsPerWorker = parseInt(env.MAX_JOBS_PER_WORKER ?? '50', 10);
    this.maxRssMb         = parseInt(env.MAX_RSS_MB ?? '250', 10);
    this.artifactBucket   = env.ARTIFACT_BUCKET   ?? 'docengine-artifacts';
    this.s3Endpoint       = env.S3_ENDPOINT;
    this.templateDir      = env.TEMPLATE_DIR      ?? '/templates/html';
  }

  static fromEnv(): Config {
    return new Config(process.env);
  }

  private require(env: NodeJS.ProcessEnv, key: string): string {
    const val = env[key];
    if (!val) throw new Error(`Required env var ${key} is not set`);
    return val;
  }
}
