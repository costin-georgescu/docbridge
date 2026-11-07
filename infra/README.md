# Deploying DocBridge to AWS

Everything below is copy-pasteable. The only manual work is creating an AWS
account and setting the printed variables. All deploy logic lives in
`scripts/aws/` and `.github/workflows/deploy.yml`.

By default each environment deploys with **no custom domain** — the whole
app is served from the distribution's default `*.cloudfront.net` address
(the `WebUrl` stack output), with `/api/*`, `/auth/*` and `/tree` routed to
an internal ALB behind a CloudFront VPC origin. Adding a domain later is a
config change, not a rebuild — see Step 0/Step 2.

Estimated durations are rough and flagged — AWS timings vary.

## Review deployment without CloudFront (API Gateway edge)

If the account is denied CloudFront (e.g. a brand-new account under review),
set `"edge": "apigw"` — optionally with `"lean": true` — on the environment.
The edge becomes an API Gateway HTTP API: `/api/{proxy+}`, `/auth/{proxy+}`
and `GET /tree` proxy to the internal ALB over a VPC link, and a Lambda
serves the SPA from the web bucket on `$default`. `lean` additionally drops
every service to count 1 and RDS to single-AZ for a short review run.

```json
{
  "staging": {
    "account": "123456789012",
    "region": "eu-central-1",
    "alarmEmail": "oncall@example.com",
    "edge": "apigw",
    "lean": true
  }
}
```

Notes:

- No custom domain (`domainName`/`hostedZoneId` are rejected together with
  `"edge": "apigw"`). `WebUrl` is the
  `https://<id>.execute-api.<region>.amazonaws.com` URL.
- API Gateway limits apply to the API routes: 30-second timeout and 10 MB
  payloads. Uploads/downloads are presigned straight to S3, so unaffected.
- The security headers (CSP, HSTS, X-Frame-Options DENY, …) are set by the
  SPA Lambda in this mode — they apply to SPA responses only, not to API
  responses from the ALB.

Everything else below is unchanged: same steps, same scripts. The web
publish step skips the CloudFront invalidation automatically when the
stack has no `DistributionId` output.

## Prerequisites

| Need               | Why                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------- |
| AWS account        | Create one; set a billing alarm before anything else.                                 |
| Admin credentials  | IAM Identity Center (SSO) user or IAM admin user; `aws sso login` / `aws configure`.  |
| Domain you control | Optional — only for domain mode; you must be able to set NS records at the registrar. |
| Docker             | Building the service images locally (`first-deploy.sh`).                              |
| Node 24 + pnpm     | `corepack enable`; the repo's `pnpm install` must work.                               |
| AWS CLI v2, jq     | Used by all helper scripts.                                                           |

## Step 0 — DNS (optional; only for domain mode)

Skip this entirely to deploy on the default `*.cloudfront.net` address —
the recommended first path. Come back here when you want a custom domain:
create the hosted zone below, set **both** `domainName` and `hostedZoneId`
in `DOCBRIDGE_ENVIRONMENTS`, and redeploy. Users must log in again
(session cookies are scoped to the old origin), and previously shared
`*.cloudfront.net` links stop working unless you redirect them.

The stack names a Route 53 **public hosted zone** exactly after the
environment's `domainName`. For `staging.example.com` that means a zone for
`staging.example.com` (a _subdomain_ zone), and `api.`/`app.` records plus
the CloudFront and ALB certificate validations are created inside it.

1. Create the public hosted zone: Route 53 console → Create hosted zone →
   name `staging.example.com` → note the **zone id** (`Z…`).
   Repeat for the production domain (e.g. `example.com`).
2. At your registrar / parent zone, create NS records for
   `staging.example.com` pointing at the four name servers Route 53 shows.
3. Wait for delegation to propagate **before** the first deploy —
   `dig NS staging.example.com` should answer with the Route 53 servers.
   ACM DNS validation and the `cdk deploy` of `DocBridgeCert-*` hang until
   it does.

## Step 1 — Bootstrap the account (once)

```bash
scripts/aws/bootstrap-account.sh <12-digit-account-id> eu-central-1 \
  --github <your-org>/<your-repo>
```

Runs with your admin credentials: verifies `aws sts get-caller-identity`,
`cdk bootstrap` in eu-central-1 **and** us-east-1 (CloudFront certs), then
deploys `infra/oidc/github-oidc-role.yaml` (stack `docbridge-github-oidc`)
which creates the `docbridge-github-deploy` OIDC role. If the account
already has a GitHub OIDC provider, pass
`--oidc-provider-arn arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com`.
Add `--dry-run` to preview every command. (~5 min.)

## Step 2 — Configure the environment values

The script prints the variables to set. In GitHub → Settings → Secrets and
variables → Actions → **Variables**:

- `AWS_DEPLOY_ROLE_ARN` — the role ARN from step 1.
- `DOCBRIDGE_ENVIRONMENTS` — JSON shaped like `cdk.json`'s
  `context.environments`; fill in your account/region/email:

```json
{
  "staging": {
    "account": "123456789012",
    "region": "eu-central-1",
    "alarmEmail": "oncall@example.com"
  },
  "production": {
    "account": "123456789012",
    "region": "eu-central-1",
    "alarmEmail": "oncall@example.com"
  }
}
```

For domain mode add `"domainName"` and `"hostedZoneId"` (the zone id from
Step 0) to each environment — they must be set together. `alarmEmail`
optional —
subscribes that address to the alarm topic AND enables the spend alerts
below; confirm the SNS email). `monthlyBudgetUsd` is optional too and
overrides the default $100 monthly budget used by the spend alerts.
`"spendAlerts": false` skips the Budgets + Cost Anomaly Detection resources
entirely — needed in regions where CloudFormation doesn't support them
(e.g. eu-north-1); create a budget manually in the Billing console instead.
You may list only the environments you care about.

Or, for local-only deploys, export the same JSON:

```bash
export DOCBRIDGE_ENVIRONMENTS='{"staging":{...}}'
```

## Step 3 — First deploy

**Via GitHub Actions (recommended):** Actions → Deploy → Run workflow →
`environment=staging`, `first_deploy=true`, `seed=true`.

**Or locally:**

```bash
scripts/aws/first-deploy.sh staging --seed
```

Both do the same ordered sequence (est. ~45–60 min, mostly NAT/RDS/CloudFront
creation):

1. `check-env.sh` — refuses to deploy against cdk.json placeholders.
2. `cdk deploy DocBridgeRepos-<env>` — the five ECR repositories.
3. Build + push the five service images (`api auth platform dispatcher
worker`), tagged with the git sha (workflow) or `local-<ts>` (dirty tree).
4. `cdk deploy DocBridgeCert-<env> DocBridge-<env> -c firstDeploy=true` —
   all infrastructure; ECS services come up at desiredCount 0. (~30–40 min.)
5. `BootstrapTaskDef` run-task — creates the `auth`/`docbridge`/`platform`
   databases and `*_app` roles on RDS (idempotent).
6. Three `MigrateTaskDef-*` run-tasks — Prisma migrate per database.
7. `pnpm aws:jwt-key …/auth/jwt-signing-key --skip-if-populated` — writes
   the RS256 signing key only when the secret is empty; never rotates.
8. Second `cdk deploy DocBridge-<env>` without `firstDeploy` — services get
   their real counts; then `aws ecs wait services-stable` (10 min cap).
9. `--seed` (staging only) — runs `SeedTaskDef`: base + demo seed.
10. Web bundle → `s3 sync` to the web bucket + CloudFront invalidation
    (skipped in `apigw` edge mode — no cache layer).

Subsequent deploys are the same workflow without `first_deploy` — see
"Routine deploys" below.

## Step 4 — Verify

The public URL is the `WebUrl` output — `https://app.<domain>` in domain
mode, `https://<id>.cloudfront.net` without a domain. Read it with:

```bash
jq -r '.["DocBridge-<env>"].WebUrl' infra/outputs.json
```

- `/health` is not publicly routed (target-group health checks only). As a
  public smoke test, `curl -i <WebUrl>/auth/.well-known/jwks.json` (CF-only)
  or `curl -i https://api.<domain>/auth/.well-known/jwks.json` (domain
  mode) → 200 with the JWKS JSON.
- CF-only: `curl <WebUrl>/api/…` returns API JSON, not `index.html`;
  `curl -i <WebUrl>/auth/service-token` → 404 `route not found` from the
  ALB default action.
- `curl -I <WebUrl>/` shows the security headers (CSP, HSTS,
  X-Frame-Options DENY) — set by CloudFront, or by the SPA lambda in
  `apigw` edge mode.
- Open `<WebUrl>` and log in. The seed (`--seed`, staging)
  creates these accounts — the password is generated per environment and
  stored in Secrets Manager; read it with:

  ```bash
  aws secretsmanager get-secret-value \
    --secret-id docbridge/<env>/seed-password --query SecretString --output text
  ```

  (the same value is injected into the seed task as `SEED_PASSWORD`; the
  task logs also print a "demo handout" with it in the
  `/docbridge/<env>/seed` log group):
  `admin@docbridge.local` (admin), `demo@docbridge.local`,
  `anna@docbridge.local`, `ben@docbridge.local`.

- Confirm the SNS subscription email (click the confirm link) if you set
  `alarmEmail`.
- CloudWatch log groups live at `/docbridge/<env>/<service>` and
  `/docbridge/<env>/{migrate-*,seed,db-bootstrap}`.

## Step 5 — TDD 5.4 checklist

- [ ] 1 GB upload: uploads >100 MB go multipart; verify the object lands in
      `s3://docbridge-platform-<env>-<account>/versions/` with the CRC32C
      checksum the api computed.
- [ ] Delivery: submit a job to a document destination on the platform,
      watch it reach the delivered state in the job detail.
- [ ] DLQ alarm: stop a worker or send a poisoned SQS message so the tasks
      DLQ (`docbridge-tasks-dlq-<env>`) gets a message → the DLQ-depth
      alarm fires to `alarmEmail`.
- [ ] RDS failover: submit a job, then
      `aws rds reboot-db-instance --db-instance-identifier <id> --force-failover`
      mid-flight; the job continues after reconnect.
- [ ] CORS/cookies: log in via `<WebUrl>` — in domain mode requests go to
      `api.<domain>` with `credentials: include` (check the preflight only
      allows `app.<domain>`); in CF-only mode they are same-origin. Either
      way, check Set-Cookie is Secure/SameSite=Strict.
- [ ] Lifecycle: `aws s3api get-bucket-lifecycle-configuration --bucket
  docbridge-staging-<env>-<account>` shows the 32-day staged-file expiry + 7-day multipart abort; objects carry `retention=completed`.
- [ ] Headers: `curl -I <WebUrl>/` shows CSP, HSTS,
      X-Frame-Options DENY etc. (CloudFront response policy; the SPA
      lambda sets the same headers in `apigw` edge mode).

## Routine deploys

- Push `dev` → staging, `master` → production — the Deploy workflow runs:
  repos → images (parallel, shared GHA cache) → stacks → bootstrap/migrate
  → jwt (skip-if-populated) → force-new-deployment → stable → web.
- Manual: Actions → Deploy → Run workflow (pick environment; `seed` is
  staging-only).
- Rollback: the ECS circuit breaker rolls a failed deployment back. To go
  back to an older image, re-run an older workflow run, or locally
  `pnpm --filter @docbridge/infra exec cdk deploy DocBridge-<env>
-c environment=<env> -c imageTag=<old-sha> --require-approval never` —
  the old sha image must still exist in ECR (last 5 are kept).

## Troubleshooting

- **Stack hangs on `DocBridgeCert-*`/certificate pending** — NS delegation
  not propagated (Step 0). `dig NS <domain>`.
- **Migrate/bootstrap task failed** — `scripts/aws/run-task.sh` tails the
  `/docbridge/<env>/{db-bootstrap,migrate-*}` log groups on failure; check
  the seed/migrate log groups in CloudWatch.
- **Services never stable** — check `/docbridge/<env>/<service>` logs;
  common cause is a missing JWT key (auth crashes in production when
  `JWT_SIGNING_KEY` is unset) or DB connectivity (run-task output first).
- **`pnpm aws:jwt-key` refuses to write** — the secret is already populated
  by design; `--skip-if-populated` is for CI. `--force` rotates the key and
  **invalidates every session cookie** — only rotate deliberately.
- **`check-env.sh` fails in CI** — `DOCBRIDGE_ENVIRONMENTS` unset or still
  the placeholder account `111111111111`.

## Cost notes

Biggest standing items: single NAT gateway + NAT data processing, Multi-AZ
`t4g.medium` RDS, the ALB, four KMS CMKs, and 10 Fargate tasks (2 each).
**None of these are free-tier eligible** — a running environment costs real
money while idle, so tear it down (`cdk destroy`, see below) or scale
services to 0 as soon as a review is done; do not leave it running.

When `alarmEmail` is set the stack also creates spend alerts: an AWS
Budgets monthly cost budget (`monthlyBudgetUsd`, default $100) emailing at
50%/80%/100% of actual and 100% of forecasted spend, plus Cost Anomaly
Detection (per-service monitor, daily digest on anomalies >= $5 impact).
The budget tracks **gross usage** — credits and refunds are excluded —
so the alerts keep working while a free-credit balance burns down.

Caveats: Budgets **alert only — they cannot cap or stop spend**, and
billing data lags roughly 8–24h, so a budget mail can arrive well after
the spend happened. Credits also don't cover every charge type (e.g.
Marketplace purchases, some support/tax items), so real billing can start
before the credit balance hits zero. If a budget mail arrives — or the
review is over — tear the stack down (`cdk destroy`, below) or scale
services to zero.

Other cost guards baked in: a free S3 gateway VPC endpoint keeps S3
traffic off the NAT, SSE-KMS bucket keys cut KMS request charges, the
platform bucket expires delivered objects after 30 days (deviation from
keep-forever), ECR keeps only 5 images per repo, and a signed
Content-Length + staged-file quotas bound what uploaders can store.
(No figures quoted; they change — check Cost Explorer after the first
week.)

## Teardown

```bash
DOCBRIDGE_ENVIRONMENTS='…' pnpm --filter @docbridge/infra exec cdk destroy \
  DocBridge-<env> DocBridgeCert-<env> DocBridgeRepos-<env> -c environment=<env>
```

Destroy order matters (main → cert → repos) since the main stack imports
the cert ARN and ECR repo ARNs. Without a domain there is no
`DocBridgeCert-<env>` stack — drop it from the command.

What survives (per the synthesized template):

- **Always retained:** the staging and platform S3 buckets
  (`DeletionPolicy: Retain` — empty them first or destroy fails) and all
  four KMS keys (`Retain`; they schedule deletion only when removed
  manually).
- **Production only:** the RDS instance has `deletionProtection` and
  `RemovalPolicy.RETAIN` — it survives `cdk destroy` entirely and must be
  deleted by hand if you want it gone.
- **Deleted:** staging RDS (non-prod), web bucket (auto-emptied), queues,
  secrets, log groups, ECS/ALB/CloudFront/VPC, and — with
  `RemovalPolicy.DESTROY` + `emptyOnDelete` — the ECR repositories.

Leftovers to clean by hand after destroy: retained buckets/keys, the RDS
(prod), the `docbridge-github-oidc` stack + OIDC provider, and the hosted
zones (created manually, never in CFN).

### Post-teardown cleanup checklist

Set `ENV=staging`, `ACCOUNT=<account id>`, `REGION=<region>` first. The KMS
keys have no aliases, so capture their ids **before** `cdk destroy`:

```bash
aws cloudformation describe-stack-resources --stack-name DocBridge-$ENV \
  --query "StackResources[?ResourceType=='AWS::KMS::Key'].PhysicalResourceId" \
  --output text
```

After destroy:

```bash
# 1. Retained S3 buckets (versioning is off, so a plain recursive delete works)
for b in staging platform; do
  aws s3 rb s3://docbridge-$b-$ENV-$ACCOUNT --force
done

# 2. Retained KMS keys (minimum 7-day wait; billing stops once pending deletion)
for k in <key-id-1> <key-id-2> <key-id-3> <key-id-4>; do
  aws kms schedule-key-deletion --key-id $k --pending-window-in-days 7
done

# 3. Hosted zone: delete every non-NS/SOA record first, then the zone
aws route53 list-resource-record-sets --hosted-zone-id <zone-id>
aws route53 delete-hosted-zone --id <zone-id>

# 4. Optional: GitHub OIDC stack/provider, CDK bootstrap
aws cloudformation delete-stack --stack-name docbridge-github-oidc
aws cloudformation delete-stack --stack-name CDKToolkit
aws s3 rb s3://cdk-hnb659fds-assets-$ACCOUNT-$REGION --force
```

Then confirm nothing is still billing: Cost Explorer for the next 2 days, and
check for leftover CloudWatch log groups, Elastic IPs and snapshots of the
RDS instance (`aws rds describe-db-snapshots`). The registered domain itself
renews separately; disable auto-renew in Route 53 if you don't want to keep it.
