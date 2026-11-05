import AWS from 'aws-sdk';
import { Logger } from 'winston';

export class S3Uploader {
  private s3: AWS.S3;

  constructor(
    private readonly bucket: string,
    endpointOverride: string | undefined,
    private readonly log: Logger,
  ) {
    this.s3 = new AWS.S3({
      endpoint:         endpointOverride,
      s3ForcePathStyle: !!endpointOverride,
      signatureVersion: 'v4',
    });
  }

  async upload(
    tenantId: string,
    documentType: string,
    jobId: string,
    pdfBytes: Buffer,
  ): Promise<string> {
    const now = new Date();
    const key = [
      tenantId,
      documentType,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      `${jobId}.pdf`,
    ].join('/');

    await this.s3.putObject({
      Bucket:      this.bucket,
      Key:         key,
      Body:        pdfBytes,
      ContentType: 'application/pdf',
      ServerSideEncryption: 'AES256',
    }).promise();

    const path = `s3://${this.bucket}/${key}`;
    this.log.info('artifact uploaded', { path });
    return path;
  }
}
