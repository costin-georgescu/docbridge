process.env.AWS_REGION ??= "eu-central-1";
process.env.NODE_ENV ??= "test";
process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.PLATFORM_BUCKET ??= "docbridge-platform";
process.env.DATABASE_URL ??=
  process.env.PLATFORM_TEST_DATABASE_URL ??
  "postgresql://platform_app:platform_app@localhost:5432/platform";
process.env.AUTH_INTERNAL_URL ??= "http://auth.test";
process.env.RATE_LIMIT_TREE_PER_MIN ??= "10000";
