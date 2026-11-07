#!/usr/bin/env bash
# Local equivalent of the deploy workflow's first deploy (see
# .github/workflows/deploy.yml). Same step order:
#   check-env -> repos -> images -> cert+main (firstDeploy) -> bootstrap ->
#   migrate -> jwt key -> main (real counts) -> wait stable -> [seed] -> web
#
#   first-deploy.sh <environment> [--seed] [--skip-web] [--dry-run]
#
# Requires: aws, docker, jq, pnpm, git. Reads DOCBRIDGE_ENVIRONMENTS.
set -euo pipefail

ENV_NAME=""
SEED=false
SKIP_WEB=false
DRY_RUN=false
for arg in "$@"; do
  case $arg in
    --seed) SEED=true ;;
    --skip-web) SKIP_WEB=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) echo "usage: $0 <environment> [--seed] [--skip-web] [--dry-run]"; exit 0 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *)
      if [ -z "$ENV_NAME" ]; then
        ENV_NAME=$arg
      else
        echo "unexpected arg: $arg" >&2
        exit 2
      fi
      ;;
  esac
done
[ -n "$ENV_NAME" ] || { echo "usage: $0 <environment> [--seed] [--skip-web] [--dry-run]" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if ! $DRY_RUN; then
  MISSING=()
  for tool in aws docker jq pnpm git; do
    command -v "$tool" >/dev/null 2>&1 || MISSING+=("$tool")
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    echo "missing tools: ${MISSING[*]}" >&2
    exit 2
  fi
fi

run() {
  if $DRY_RUN; then echo "+ $*"; else "$@"; fi
}
STACK="DocBridge-$ENV_NAME"

"$REPO_ROOT/scripts/aws/check-env.sh" "$ENV_NAME"

# Same tag strategy as the workflow: git sha; local builds get local-<ts>
# when the tree is dirty so a dirty run can't impersonate a sha.
if $DRY_RUN; then
  IMAGE_TAG="<git-sha-or-local-ts>"
elif git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet; then
  IMAGE_TAG=$(git -C "$REPO_ROOT" rev-parse HEAD)
else
  IMAGE_TAG="local-$(date +%s)"
fi
echo "image tag: $IMAGE_TAG"

echo "== 1/8 deploy ECR repositories"
run pnpm --filter @docbridge/infra exec cdk deploy "DocBridgeRepos-$ENV_NAME" \
  --require-approval never -c "environment=$ENV_NAME"

echo "== 2/8 build and push images"
if $DRY_RUN; then
  echo "+ aws ecr get-login-password | docker login <registry>"
  for app in api auth platform dispatcher worker; do
    echo "+ docker buildx build -f docker/app.Dockerfile --build-arg APP=$app -t <registry>/docbridge/$app:$IMAGE_TAG --push ."
  done
else
  REGION=$(printf '%s' "${DOCBRIDGE_ENVIRONMENTS:-}" | jq -r --arg e "$ENV_NAME" '.[$e].region // "eu-central-1"')
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  docker buildx create --use --name docbridge-deploy 2>/dev/null || docker buildx use docbridge-deploy
  for app in api auth platform dispatcher worker; do
    docker buildx build -f "$REPO_ROOT/docker/app.Dockerfile" \
      --platform linux/amd64 \
      --build-arg "APP=$app" \
      -t "$REGISTRY/docbridge/$app:$IMAGE_TAG" \
      -t "$REGISTRY/docbridge/$app:latest" \
      --push "$REPO_ROOT"
  done
fi

echo "== 3/8 deploy cert + main stacks (firstDeploy: services at 0)"
run pnpm --filter @docbridge/infra exec cdk deploy "$STACK" \
  --require-approval never -c "imageTag=$IMAGE_TAG" -c "environment=$ENV_NAME" \
  -c firstDeploy=true --outputs-file infra/outputs.json

echo "== 4/8 bootstrap databases and roles"
run "$REPO_ROOT/scripts/aws/run-task.sh" infra/outputs.json "$STACK" BootstrapTaskDef

echo "== 5/8 run migrations"
for db in auth docbridge platform; do
  run "$REPO_ROOT/scripts/aws/run-task.sh" infra/outputs.json "$STACK" "MigrateTaskDef-$db"
done

echo "== 6/8 provision JWT signing key (skips if populated)"
run pnpm aws:jwt-key "docbridge/$ENV_NAME/auth/jwt-signing-key" --skip-if-populated

echo "== 7/8 enable services + wait for stability"
run pnpm --filter @docbridge/infra exec cdk deploy "$STACK" \
  --require-approval never -c "imageTag=$IMAGE_TAG" -c "environment=$ENV_NAME" \
  --outputs-file infra/outputs.json
if $DRY_RUN; then
  echo "+ timeout 600 aws ecs wait services-stable --cluster <cluster> --services <names>"
else
  CLUSTER=$(jq -r --arg s "$STACK" '.[$s].ClusterName' infra/outputs.json)
  SERVICES=$(jq -r --arg s "$STACK" '.[$s].ServiceNames' infra/outputs.json | tr ',' ' ')
  # shellcheck disable=SC2086
  timeout 600 aws ecs wait services-stable --cluster "$CLUSTER" --services $SERVICES
fi

if $SEED; then
  if [ "$ENV_NAME" = "staging" ]; then
    echo "== seed demo data"
    run "$REPO_ROOT/scripts/aws/run-task.sh" infra/outputs.json "$STACK" SeedTaskDef
  else
    echo "== seed skipped (staging only)"
  fi
fi

echo "== 8/8 publish web bundle"
if $SKIP_WEB; then
  echo "skipped (--skip-web)"
elif $DRY_RUN; then
  echo "+ VITE_API_BASE_URL=https://api.<domain> pnpm --filter @docbridge/web build  # domain mode"
  echo "+ pnpm --filter @docbridge/web build                                        # same-origin (cloudfront-only / apigw edge)"
  echo "+ aws s3 sync apps/web/dist s3://<WebBucketName> --delete"
  echo "+ aws cloudfront create-invalidation --distribution-id <DistributionId> --paths /*  # skipped when the stack has no DistributionId (apigw edge)"
else
  DOMAIN=$(printf '%s' "${DOCBRIDGE_ENVIRONMENTS:-}" | jq -r --arg e "$ENV_NAME" '.[$e].domainName // empty')
  if [ -z "$DOMAIN" ]; then
    DOMAIN=$(jq -r --arg e "$ENV_NAME" '.context.environments[$e].domainName // empty' "$REPO_ROOT/infra/cdk.json")
  fi
  BUCKET=$(jq -r --arg s "$STACK" '.[$s].WebBucketName' infra/outputs.json)
  DIST=$(jq -r --arg s "$STACK" '.[$s].DistributionId // empty' infra/outputs.json)
  if [ -n "$DOMAIN" ]; then
    VITE_API_BASE_URL="https://api.$DOMAIN" pnpm --filter @docbridge/web build
  else
    # No domain: the API is same-origin behind the /api/*, /auth/* and
    # /tree edge routes (CloudFront behaviors or API Gateway routes) —
    # the vite default ("") applies.
    pnpm --filter @docbridge/web build
  fi
  aws s3 sync "$REPO_ROOT/apps/web/dist" "s3://$BUCKET" --delete
  # apigw edge has no DistributionId and no cache layer to invalidate
  # (the SPA lambda serves index.html with Cache-Control: no-cache).
  if [ -n "$DIST" ]; then
    aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*"
  fi
fi

WEB_URL=$(jq -r --arg s "$STACK" '.[$s].WebUrl // empty' infra/outputs.json 2>/dev/null || true)
if [ -n "$WEB_URL" ]; then
  echo "done. Open $WEB_URL"
elif [ -n "${DOMAIN:-}" ]; then
  echo "done. Open https://app.$DOMAIN"
else
  echo "done."
fi
