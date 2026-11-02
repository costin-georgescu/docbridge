# Deploying DocBridge to AWS

Everything below is copy-pasteable. The only manual work is creating an AWS
account, a domain/hosted zone, and setting the printed variables. All deploy
logic lives in `scripts/aws/` and `.github/workflows/deploy.yml`.

Estimated durations are rough and flagged — AWS timings vary.

## Prerequisites

| Need               | Why                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------ |
| AWS account        | Create one; set a billing alarm before anything else.                                |
| Admin credentials  | IAM Identity Center (SSO) user or IAM admin user; `aws sso login` / `aws configure`. |
| Domain you control | You must be able to set NS records at the registrar.                                 |
| Docker             | Building the service images locally (`first-deploy.sh`).                             |
| Node 24 + pnpm     | `corepack enable`; the repo's `pnpm install` must work.                              |
| AWS CLI v2, jq     | Used by all helper scripts.                                                          |

## Step 0 — DNS (do this first, it blocks ACM validation)

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
  `context.environments`; fill in your zone id/domain/email:

```json
{
  "staging": {
    "domainName": "staging.example.com",
    "hostedZoneId": "Z1234567890ABCDEFGHIJ",
    "account": "123456789012",
    "region": "eu-central-1",
    "alarmEmail": "oncall@example.com"
  },
  "production": {
    "domainName": "example.com",
    "hostedZoneId": "Z1234567890ABCDEFGHIJ",
    "account": "123456789012",
    "region": "eu-central-1",
    "alarmEmail": "oncall@example.com"
  }
}
```

`hostedZoneId` is the Route 53 zone id from Step 0 (`alarmEmail` optional —
subscribes that address to the alarm topic; confirm the SNS email).
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
10. Web bundle → `s3 sync` to the web bucket + CloudFront invalidation.

Subsequent deploys are the same workflow without `first_deploy` — see
"Routine deploys" below.

## Step 4 — Verify

- `curl https://api.<domain>/health` → `{"status":"ok"}`.
- Open `https://app.<domain>` and log in. The seed (`--seed`, staging)
  creates these accounts — the password is `password123` for all of them
  (hardcoded in `scripts/seed.ts` / `scripts/demo-seed.ts`; the task logs
  also print a "grader handout" with the same credentials in the
  `/docbridge/<env>/seed` log group — change/remove for anything real):
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
- [ ] CORS/cookies: log in via `https://app.<domain>` — requests go to
      `api.<domain>` with `credentials: include`; check Set-Cookie is
      Secure/SameSite and the CORS preflight only allows `app.<domain>`.
- [ ] Lifecycle: `aws s3api get-bucket-lifecycle-configuration --bucket
    docbridge-staging-<env>-<account>` shows the 32-day staged-file expiry + 7-day multipart abort; objects carry `retention=completed`.
- [ ] Headers: `curl -I https://app.<domain>/` shows CSP, HSTS,
      X-Frame-Options DENY etc. from the CloudFront response policy.

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
  the old sha image must still exist in ECR (last 20 are kept).

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
Staging costs real money while idle — prefer `cdk destroy` or scaled-down
counts when not in use. (No figures quoted; they change — check Cost
Explorer after the first week.)

## Teardown

```bash
DOCBRIDGE_ENVIRONMENTS='…' pnpm --filter @docbridge/infra exec cdk destroy \
  DocBridge-<env> DocBridgeCert-<env> DocBridgeRepos-<env> -c environment=<env>
```

Destroy order matters (main → cert → repos) since the main stack imports
the cert ARN and ECR repo ARNs.

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
