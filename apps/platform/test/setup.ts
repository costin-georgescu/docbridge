process.env.AWS_REGION ??= "eu-central-1";
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??=
  process.env.PLATFORM_TEST_DATABASE_URL ??
  "postgresql://platform_app:platform_app@localhost:5432/platform";
process.env.AUTH_INTERNAL_URL ??= "http://auth.test";
