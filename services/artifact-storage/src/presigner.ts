/**
 * Generates ephemeral S3 presigned GET URLs.
 *
 * The URL is cryptographically bound to the exact S3 object key and expires
 * after cfg.presignTtlSec seconds. It is never stored — only sent to the
 * webhook endpoint so the caller can download the PDF exactly once.
 */
import AWS from 'aws-sdk';
import { Config } from './config';

export class Presigner {
  private s3: AWS.S3;
  private bucket: string;
  private ttlSec: number;

  constructor(cfg: Config) {
    this.s3 = new AWS.S3({
      region:           cfg.awsRegion,
      endpoint:         cfg.s3Endpoint,
      s3ForcePathStyle: !!cfg.s3Endpoint,
      signatureVersion: 'v4',
    });
    this.bucket = cfg.artifactBucket;
    this.ttlSec = cfg.presignTtlSec;
  }

  /**
   * Generates a presigned GET URL for `storagePath` (s3://bucket/key format).
   * Returns the URL string valid for `ttlSec` seconds.
   */
  async generateUrl(storagePath: string): Promise<string> {
    const key = storagePath.replace(`s3://${this.bucket}/`, '');
    return this.s3.getSignedUrlPromise('getObject', {
      Bucket:  this.bucket,
      Key:     key,
      Expires: this.ttlSec,
    });
  }
}
