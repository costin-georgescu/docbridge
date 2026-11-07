#!/usr/bin/env bash
# Run a one-off ECS Fargate task (bootstrap / migrate / seed) and fail if the
# container exits non-zero.
#
#   run-task.sh <outputs.json> <stack-name> <output-key> [--dry-run]
#
# Reads ClusterName / ServiceSecurityGroup / PrivateSubnetIds and the task
# definition ARN (<output-key>) from the cdk deploy outputs file. On failure
# prints recent container logs (log group /docbridge/<env>/<task>) to aid
# debugging. --dry-run prints the commands without calling AWS.
set -euo pipefail

if [ $# -lt 3 ]; then
  echo "usage: $0 <outputs.json> <stack-name> <output-key> [--dry-run]" >&2
  exit 2
fi
OUTPUTS_FILE=$1
STACK=$2
KEY=$3
DRY_RUN=${4:-}

stack_outputs() {
  jq -r --arg stack "$STACK" '.[$stack]' "$OUTPUTS_FILE"
}
output_value() {
  jq -r --arg stack "$STACK" --arg key "$1" '.[$stack][$key]' "$OUTPUTS_FILE"
}

CLUSTER=$(output_value ClusterName)
SG=$(output_value ServiceSecurityGroup)
SUBNETS=$(output_value PrivateSubnetIds)
TDEF=$(output_value "$KEY")
NET="awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}"

# Log group hint: /docbridge/<env>/<task>; the env name comes from the stack
# name (DocBridge-<env>) and the task name from the output key
# (MigrateTaskDef-auth -> migrate-auth, BootstrapTaskDef -> db-bootstrap,
# SeedTaskDef -> seed).
ENV_NAME=${STACK#DocBridge-}
case $KEY in
  MigrateTaskDef*) LOG_SUFFIX="migrate-${KEY#MigrateTaskDef}"; LOG_SUFFIX=${LOG_SUFFIX/migrate--/migrate-} ;;
  BootstrapTaskDef) LOG_SUFFIX="db-bootstrap" ;;
  SeedTaskDef) LOG_SUFFIX="seed" ;;
  *) LOG_SUFFIX=$(echo "$KEY" | tr '[:upper:]' '[:lower:]') ;;
esac
LOG_GROUP="/docbridge/${ENV_NAME}/${LOG_SUFFIX}"

echo "run-task: $KEY -> $TDEF (logs: $LOG_GROUP)"

if [ "$DRY_RUN" = "--dry-run" ]; then
  cat <<EOF
aws ecs run-task --cluster $CLUSTER --launch-type FARGATE \\
  --task-definition $TDEF --network-configuration '$NET'
aws ecs wait tasks-stopped --cluster $CLUSTER --tasks <task-arn>
aws ecs describe-tasks --cluster $CLUSTER --tasks <task-arn> \\
  --query 'tasks[0].containers[0].exitCode'
EOF
  exit 0
fi

TASK=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE \
  --task-definition "$TDEF" \
  --network-configuration "$NET" \
  --query 'tasks[0].taskArn' --output text)
echo "task: $TASK"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" \
  --query 'tasks[0].containers[0].exitCode' --output text)

if [ "$CODE" != "0" ]; then
  echo "run-task $KEY failed (container exit code $CODE)" >&2
  echo "recent logs from $LOG_GROUP:" >&2
  aws logs tail "$LOG_GROUP" --since 30m 2>/dev/null | tail -50 >&2 || true
  exit 1
fi
echo "run-task $KEY: done"
