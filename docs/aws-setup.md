# AWS setup

Everything here is configured in the console; the app only reads the environment variables below.
Assumes one CloudFront distribution for `scratchd.dev` serving both the app and the files, so file
URLs are same-origin and need no CORS.

## DynamoDB
- Table `scratchd`, partition key `pk` (String), on-demand capacity.
- Time to Live on attribute `ttl`.

## S3
- Bucket `scratchd`: Block Public Access on, default encryption SSE-S3.
- Lifecycle rule on prefix `pads/`: expire current versions after 1 day, delete incomplete multipart uploads after 1 day.
- Bucket policy: allow principal `cloudfront.amazonaws.com` `s3:GetObject` and `s3:PutObject` on
  `arn:aws:s3:::scratchd/pads/*`, condition `AWS:SourceArn` = the distribution's ARN.

## CloudFront signing key
- `openssl genrsa -out cf.pem 2048` and `openssl rsa -in cf.pem -pubout -out cf.pub`.
- Upload `cf.pub` as a public key, put it in a key group. Its ID is `CLOUDFRONT_KEY_PAIR_ID`.
- Store `cf.pem` in Parameter Store as SecureString `/scratchd/cloudfront-private-key` (standard tier, default `aws/ssm` key), then delete the local file.

## CloudFront distribution
- Alternate domains `scratchd.dev`, `scratched.dev`; ACM certificate in us-east-1; viewer protocol: redirect HTTP to HTTPS.
- Origin 1: the ALB. Default behavior: all methods, cache policy `CachingDisabled`, origin request policy `AllViewer`.
- Origin 2: the bucket with an Origin Access Control (sign requests: always).
- Behavior `pads/*` to the bucket: methods GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE; restrict viewer access to the key group;
  cache policy `CachingDisabled`; an origin request policy that forwards all query strings (`partNumber`, `uploadId`).
- `scratched.dev`: a viewer-request CloudFront Function that returns a 301 to `https://scratchd.dev` + the same path.

## WAF (web ACL on the distribution)
- If the AWS Core rule set is attached, set its `SizeRestrictions_BODY` rule to Count. It blocks bodies over 8 KB, which is every upload part.
- Block oversized parts: method `PUT` AND header `content-length` matches regex `^[1-9][0-9]{7,}$` (10 MB or more; parts are 8 MB).
- Rate-based rules, per IP, each scoped down by URI path:
  - `POST` with URI exactly `/api/pads`: 20 per 10 minutes.
  - URI starts with `/api/channels/` and ends with `/claim`: 20 per 5 minutes.
  - `GET` with URI starting `/api/channels/`: 600 per 5 minutes.
  - URI starting `/api/`: 3000 per 5 minutes.

## Network
- ALB security group: inbound only from the managed prefix list `com.amazonaws.global.cloudfront.origin-facing`, so nobody can skip WAF.

## ECR and GitHub Actions
- ECR repository `scratchd`, tag mutability mutable (the workflow moves `latest`); lifecycle rule: keep the last 10 images.
- IAM identity provider: OpenID Connect, URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
- IAM role for GitHub: trusted by that provider with conditions `token.actions.githubusercontent.com:aud` = `sts.amazonaws.com`
  and `token.actions.githubusercontent.com:sub` = `repo:super1iminal/scratchd:ref:refs/heads/main`.
  Permissions: `ecr:GetAuthorizationToken` on `*`; `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`,
  `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`, `ecr:BatchGetImage` on the repository ARN.
- GitHub repo, Settings > Secrets and variables > Actions > Variables: `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REPOSITORY` (`scratchd`).
- After a push, deploy with ECS "Update service" > "Force new deployment" (the task definition uses `:latest`).

## ECS
- Image: `<account>.dkr.ecr.<region>.amazonaws.com/scratchd:latest`.
- Task role: `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` on the table; `s3:PutObject`, `s3:AbortMultipartUpload`,
  `s3:ListMultipartUploadParts`, `s3:DeleteObject` on `arn:aws:s3:::scratchd/pads/*`.
- Execution role: the usual ECR and logs access, plus `ssm:GetParameters` on the parameter's ARN.
- Container: `readonlyRootFilesystem: true`; ALB health check on `/api/health`.
- Environment: `CLOUDFRONT_DOMAIN=scratchd.dev`, `CLOUDFRONT_KEY_PAIR_ID=<id>`; optional `TABLE_NAME`, `BUCKET`, `DAILY_UPLOAD_BYTES` (default 25 GiB).
- Secrets: `CLOUDFRONT_PRIVATE_KEY` from the Parameter Store ARN.
- Never set `DYNAMO_ENDPOINT` or `S3_ENDPOINT` in AWS: they switch on the local-dev setup.

## Billing
- AWS Budgets: a monthly cost budget with email alerts at 50% and 100%.

## GitHub
- Settings > Code security: turn on Dependabot alerts and security updates (`.github/dependabot.yml` handles version updates).

## Removing a reported pad
- Delete item `pad#<id>` from the table and object `pads/<id>` from the bucket.
