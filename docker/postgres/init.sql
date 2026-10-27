CREATE ROLE auth_app LOGIN PASSWORD 'auth_app';
CREATE ROLE docbridge_app LOGIN PASSWORD 'docbridge_app';
CREATE ROLE platform_app LOGIN PASSWORD 'platform_app';

CREATE DATABASE auth OWNER auth_app;
CREATE DATABASE docbridge OWNER docbridge_app;
CREATE DATABASE platform OWNER platform_app;

REVOKE CONNECT ON DATABASE auth, docbridge, platform FROM PUBLIC;

\c auth
CREATE EXTENSION IF NOT EXISTS citext;
