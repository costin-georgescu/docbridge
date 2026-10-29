#!/bin/bash
set -euo pipefail
export AWS_DEFAULT_REGION=eu-central-1
ACCOUNT=000000000000

for bucket in docbridge-staging docbridge-platform; do
  awslocal s3api head-bucket --bucket "$bucket" 2>/dev/null ||
    awslocal s3 mb "s3://$bucket"
done

# Browser uploads (presigned PUT/UploadPart) hit the staging bucket directly.
awslocal s3api put-bucket-cors --bucket docbridge-staging --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"]
  }]
}'

awslocal sqs create-queue --queue-name docbridge-upload-events-dlq \
  --attributes MessageRetentionPeriod=1209600 >/dev/null
awslocal sqs create-queue --queue-name docbridge-upload-events --attributes '{
  "VisibilityTimeout": "60",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"arn:aws:sqs:eu-central-1:'"$ACCOUNT"':docbridge-upload-events-dlq\",\"maxReceiveCount\":\"5\"}"
}' >/dev/null

awslocal sqs create-queue --queue-name docbridge-tasks-dlq \
  --attributes MessageRetentionPeriod=1209600 >/dev/null
awslocal sqs create-queue --queue-name docbridge-tasks --attributes '{
  "VisibilityTimeout": "1200",
  "ReceiveMessageWaitTimeSeconds": "20",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"arn:aws:sqs:eu-central-1:'"$ACCOUNT"':docbridge-tasks-dlq\",\"maxReceiveCount\":\"3\"}"
}' >/dev/null

UPLOAD_EVENTS_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "http://localhost:4566/$ACCOUNT/docbridge-upload-events" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal s3api put-bucket-notification-configuration \
  --bucket docbridge-staging \
  --notification-configuration '{
    "QueueConfigurations": [{
      "Id": "upload-events",
      "QueueArn": "'"$UPLOAD_EVENTS_ARN"'",
      "Events": ["s3:ObjectCreated:Put", "s3:ObjectCreated:CompleteMultipartUpload"],
      "Filter": {"Key": {"FilterRules": [{"Name": "prefix", "Value": "staged/"}]}}
    }]
  }'

if ! awslocal kms list-aliases \
    --query "Aliases[?AliasName=='alias/docbridge-local'].AliasName" \
    --output text | grep -q docbridge-local; then
  KEY_ID=$(awslocal kms create-key --query 'KeyMetadata.KeyId' --output text)
  awslocal kms create-alias \
    --alias-name alias/docbridge-local --target-key-id "$KEY_ID"
fi

awslocal secretsmanager describe-secret \
  --secret-id docbridge/local/placeholder >/dev/null 2>&1 ||
  awslocal secretsmanager create-secret \
    --name docbridge/local/placeholder --secret-string '{}' >/dev/null

echo "localstack init complete"
