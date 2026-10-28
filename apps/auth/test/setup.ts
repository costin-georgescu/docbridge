process.env.AWS_REGION ??= "eu-central-1";
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??=
  process.env.AUTH_TEST_DATABASE_URL ??
  "postgresql://auth_app:auth_app@localhost:5432/auth";
