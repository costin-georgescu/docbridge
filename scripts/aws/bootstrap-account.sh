#!/usr/bin/env bash
# One-time AWS account prep, run with admin credentials:
#   bootstrap-account.sh <account-id> [region] --github <org>/<repo> \
#     [--oidc-provider-arn <arn>] [--dry-run]
# Bootstraps CDK in <region> + us-east-1 and deploys the GitHub OIDC role,
# then prints the GitHub repo variables to set.
set -euo pipefail

REGION="eu-central-1"
GITHUB=""
OIDC_ARN=""
DRY_RUN=false
ACCOUNT=""

usage() {
  echo "usage: $0 <account-id> [region] --github <org>/<repo> [--oidc-provider-arn <arn>] [--dry-run]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case $1 in
    --github) GITHUB=${2:-}; shift 2 ;;
    --oidc-provider-arn) OIDC_ARN=${2:-}; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -*) usage ;;
    *)
      if [ -z "$ACCOUNT" ]; then ACCOUNT=$1
      elif [ "$REGION" = "eu-central-1" ]; then REGION=$1
      else usage; fi
      shift ;;
  esac
done
[ -n "$ACCOUNT" ] && [ -n "$GITHUB" ] || usage
[[ $ACCOUNT =~ ^[0-9]{12}$ ]] || { echo "account id must be 12 digits" >&2; usage; }
[[ $GITHUB =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "--github must be <org>/<repo>" >&2; usage; }

ORG=${GITHUB%%/*}
REPO=${GITHUB#*/}
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if ! $DRY_RUN; then
  MISSING=()
  for tool in aws jq pnpm; do
    command -v "$tool" >/dev/null 2>&1 || MISSING+=("$tool")
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    echo "missing tools: ${MISSING[*]}" >&2
    exit 2
  fi
fi

say() { echo "+ $*"; }
run() {
  if $DRY_RUN; then echo "+ $*"; else "$@"; fi
}

if $DRY_RUN; then
  say "aws sts get-caller-identity  # expect account $ACCOUNT"
else
  ACTUAL=$(aws sts get-caller-identity --query Account --output text)
  if [ "$ACTUAL" != "$ACCOUNT" ]; then
    echo "caller identity is $ACTUAL, expected $ACCOUNT" >&2
    exit 1
  fi
  echo "caller identity: $ACTUAL"
fi

echo "== CDK bootstrap ($REGION + us-east-1)"
run pnpm --filter @docbridge/infra exec cdk bootstrap "aws://$ACCOUNT/$REGION"
run pnpm --filter @docbridge/infra exec cdk bootstrap "aws://$ACCOUNT/us-east-1"

echo "== GitHub OIDC role"
PARAMS=(GitHubOrg="$ORG" GitHubRepo="$REPO")
if [ -n "$OIDC_ARN" ]; then
  PARAMS+=(ExistingOidcProviderArn="$OIDC_ARN")
fi
if $DRY_RUN; then
  say "aws cloudformation deploy --template-file infra/oidc/github-oidc-role.yaml \\"
  say "  --stack-name docbridge-github-oidc --capabilities CAPABILITY_NAMED_IAM \\"
  say "  --parameter-overrides ${PARAMS[*]}"
  ROLE_ARN="<DeployRoleArn from stack outputs>"
else
  run aws cloudformation deploy \
    --template-file "$REPO_ROOT/infra/oidc/github-oidc-role.yaml" \
    --stack-name docbridge-github-oidc \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides "${PARAMS[@]}"
  ROLE_ARN=$(aws cloudformation describe-stacks \
    --stack-name docbridge-github-oidc \
    --query 'Stacks[0].Outputs' --output json \
    | jq -r '.[] | select(.OutputKey=="DeployRoleArn") | .OutputValue')
fi

cat <<EOF

== Next: set these repository variables
   GitHub > Settings > Secrets and variables > Actions > Variables

AWS_DEPLOY_ROLE_ARN = $ROLE_ARN

DOCBRIDGE_ENVIRONMENTS = {"staging":{"account":"$ACCOUNT","region":"$REGION","alarmEmail":"<ops@your-domain>"},"production":{"account":"$ACCOUNT","region":"$REGION","alarmEmail":"<ops@your-domain>"}}

Replace the <...> placeholders with your email. This shape deploys each
environment on its default *.cloudfront.net address — no domain needed.
To use a custom domain later, add "domainName":"<your-domain>" and
"hostedZoneId":"<zone-id>" together (both or neither) and redeploy.
EOF
