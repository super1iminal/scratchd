import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BucketAlreadyOwnedByYou, CreateBucketCommand, GetObjectCommand, PutBucketCorsCommand, S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as signS3 } from '@aws-sdk/s3-request-presigner';
import { getSignedUrl as signCloudFront } from '@aws-sdk/cloudfront-signer';

const env = process.env;
export const TABLE = env.TABLE_NAME ?? 'scratchd';
export const BUCKET = env.BUCKET ?? 'scratchd';
const URL_TTL_S = 15 * 60;

// *_ENDPOINT are set only in local dev (DynamoDB Local, RustFS); in AWS the SDK finds the services itself.
export const db = DynamoDBDocumentClient.from(new DynamoDBClient(env.DYNAMO_ENDPOINT ? { endpoint: env.DYNAMO_ENDPOINT } : {}));
// The SDK would otherwise bake a checksum of the (empty) body into presigned upload URLs.
const checksums = { requestChecksumCalculation: 'WHEN_REQUIRED' } as const;
export const s3 = new S3Client(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true, ...checksums } : checksums);
// Dev in Docker: the browser reaches the S3 stand-in on a different host than the server does.
const s3ForBrowser = env.S3_PUBLIC_ENDPOINT ? new S3Client({ endpoint: env.S3_PUBLIC_ENDPOINT, forcePathStyle: true, ...checksums }) : s3;

// Browser-facing URL for one upload part (when `part` is given) or for reading the object.
// Production goes through CloudFront (OAC signs the request on to S3); dev signs straight to RustFS.
export function signedUrl(key: string, part?: { uploadId: string; partNumber: number }): Promise<string> {
  if (env.CLOUDFRONT_DOMAIN) {
    const query = part ? `?partNumber=${part.partNumber}&uploadId=${encodeURIComponent(part.uploadId)}` : '';
    return Promise.resolve(
      signCloudFront({
        url: `https://${env.CLOUDFRONT_DOMAIN}/${key}${query}`,
        keyPairId: env.CLOUDFRONT_KEY_PAIR_ID!,
        privateKey: env.CLOUDFRONT_PRIVATE_KEY!,
        dateLessThan: new Date(Date.now() + URL_TTL_S * 1000),
      }),
    );
  }
  return part
    ? signS3(s3ForBrowser, new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId: part.uploadId, PartNumber: part.partNumber }), { expiresIn: URL_TTL_S })
    : signS3(s3ForBrowser, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: URL_TTL_S });
}

// Local dev only: create the table and bucket that AWS gets through the console.
export async function ensureDevResources() {
  await db
    .send(
      new CreateTableCommand({
        TableName: TABLE,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    )
    .catch((e) => {
      if (!(e instanceof ResourceInUseException)) throw e;
    });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch((e) => {
    if (!(e instanceof BucketAlreadyOwnedByYou)) throw e;
  });
  // Same CORS rule the real bucket needs: the browser PUTs parts, reads ETags, and GETs byte ranges.
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: BUCKET,
      CORSConfiguration: { CORSRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET', 'PUT'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }] },
    }),
  );
}
