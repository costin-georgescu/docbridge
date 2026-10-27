CREATE ROLE auth_app LOGIN PASSWORD 'auth_app' CREATEDB;
CREATE ROLE docbridge_app LOGIN PASSWORD 'docbridge_app' CREATEDB;
CREATE ROLE platform_app LOGIN PASSWORD 'platform_app' CREATEDB;

CREATE DATABASE auth OWNER auth_app;
CREATE DATABASE docbridge OWNER docbridge_app;
CREATE DATABASE platform OWNER platform_app;

REVOKE CONNECT ON DATABASE auth, docbridge, platform FROM PUBLIC;

\c auth
CREATE EXTENSION IF NOT EXISTS citext;
