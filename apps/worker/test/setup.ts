process.env.AWS_REGION ??= "eu-central-1";
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??=
  process.env.WORKER_TEST_DATABASE_URL ??
  "postgresql://docbridge_app:docbridge_app@localhost:5432/docbridge";
process.env.STAGING_BUCKET ??= "docbridge-staging";
process.env.PLATFORM_BUCKET ??= "docbridge-platform";
process.env.TASKS_QUEUE_URL =
  "http://localhost:4566/000000000000/docbridge-worker-tasks-test";
process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.AUTH_INTERNAL_URL ??= "http://localhost:3001";
process.env.PLATFORM_INTERNAL_URL ??= "http://localhost:3002";
process.env.WORKER_CLIENT_SECRET ??= "test-worker-secret";
