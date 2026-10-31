process.env.AWS_REGION ??= "eu-central-1";
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??=
  process.env.API_TEST_DATABASE_URL ??
  "postgresql://docbridge_app:docbridge_app@localhost:5432/docbridge";
process.env.AUTH_INTERNAL_URL ??= "http://auth.test";
process.env.PLATFORM_INTERNAL_URL ??= "http://platform.test";
process.env.STAGING_BUCKET ??= "docbridge-staging";
process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.RATE_LIMIT_JOBS_PER_MIN ??= "10000";
process.env.RATE_LIMIT_UPLOADS_PER_MIN ??= "10000";
