export class Config {
  readonly redisUrl:       string;
  readonly consumerGroup:  string;
  readonly consumerName:   string;
  readonly databaseUrl:    string;
  readonly artifactBucket: string;
  readonly s3Endpoint?:    string;
  readonly awsRegion:      string;
  /** TTL for presigned URLs, in seconds. Default 3600 (1 hour). */
  readonly presignTtlSec:  number;

  private constructor(env: NodeJS.ProcessEnv) {
    this.redisUrl       = this.req(env, 'REDIS_URL');
    this.consumerGroup  = env.CONSUMER_GROUP  ?? 'notification-workers';
    this.consumerName   = env.CONSUMER_NAME   ?? `notifier-${process.pid}`;
    this.databaseUrl    = this.req(env, 'DATABASE_URL');
    this.artifactBucket = env.ARTIFACT_BUCKET ?? 'docengine-artifacts';
    this.s3Endpoint     = env.S3_ENDPOINT;
    this.awsRegion      = env.AWS_REGION      ?? 'ap-south-1';
    this.presignTtlSec  = parseInt(env.PRESIGN_TTL_SEC ?? '3600', 10);
  }

  static fromEnv(): Config { return new Config(process.env); }

  private req(env: NodeJS.ProcessEnv, key: string): string {
    const v = env[key];
    if (!v) throw new Error(`Required env var ${key} not set`);
    return v;
  }
}
