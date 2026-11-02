#!/usr/bin/env bash
# Fail fast when the deploy is pointed at cdk.json placeholder values.
# Account 111111111111 means DOCBRIDGE_ENVIRONMENTS was never configured.
#
#   check-env.sh <environment-name>
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <environment-name>" >&2
  exit 2
fi
ENV_NAME=$1
CDK_JSON="$(cd "$(dirname "$0")" && pwd)/../../infra/cdk.json"

if [ -n "${DOCBRIDGE_ENVIRONMENTS:-}" ]; then
  ACCOUNT=$(printf '%s' "$DOCBRIDGE_ENVIRONMENTS" | jq -r --arg e "$ENV_NAME" '.[$e].account // empty')
else
  ACCOUNT=$(jq -r --arg e "$ENV_NAME" '.context.environments[$e].account // empty' "$CDK_JSON")
fi

if [ -z "$ACCOUNT" ]; then
  echo "environment \"$ENV_NAME\" not found in the environment config" >&2
  exit 1
fi
if [ "$ACCOUNT" = "111111111111" ]; then
  echo "environment \"$ENV_NAME\" still uses the placeholder account $ACCOUNT." >&2
  echo "Set the DOCBRIDGE_ENVIRONMENTS repo variable (JSON shaped like" >&2
  echo "cdk.json context.environments) with the real account/zone/domain." >&2
  exit 1
fi
echo "check-env: $ENV_NAME -> account $ACCOUNT"
