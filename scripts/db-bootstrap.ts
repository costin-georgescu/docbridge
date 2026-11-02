import { createClient } from "@docbridge/db-docbridge";
import { withDbSsl } from "@docbridge/config";

// Creates the app roles + databases on a fresh Postgres (RDS or local
// compose), mirroring docker/postgres/init.sql. Idempotent; safe to re-run.
//
// Master credentials come from the RDS master secret as MASTER_DB_* parts;
// each app database from its docbridge/<env>/db/<name> secret as <P>_DB_*.
// DB_SSL maps to pg's sslmode — RDS sets rds.force_ssl=1 and the tasks use
// no-verify (the RDS CA isn't in Node's trust store); local compose has no
// SSL so leave it unset there.

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`invalid SQL identifier: ${name}`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

interface Target {
  db: string;
  role: string;
  password: string;
}

const master = {
  host: required("MASTER_DB_HOST"),
  port: process.env.MASTER_DB_PORT ?? "5432",
  user: required("MASTER_DB_USERNAME"),
  password: required("MASTER_DB_PASSWORD"),
  adminDb: process.env.MASTER_DB_NAME ?? "postgres",
};

const targets: Target[] = ["AUTH", "DOCBRIDGE", "PLATFORM"].map((prefix) => ({
  db: required(`${prefix}_DB_NAME`),
  role: required(`${prefix}_DB_USERNAME`),
  password: required(`${prefix}_DB_PASSWORD`),
}));

function url(user: string, password: string, db: string): string {
  return withDbSsl(
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
      `@${master.host}:${master.port}/${db}`,
  );
}

async function main() {
  const admin = createClient(url(master.user, master.password, master.adminDb));
  const masterId = quoteIdent(master.user);
  for (const target of targets) {
    const roleId = quoteIdent(target.role);
    const dbId = quoteIdent(target.db);
    const roleExists = await admin.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(target.role)}`,
    );
    if (roleExists.length > 0) {
      await admin.$executeRawUnsafe(
        `ALTER ROLE ${roleId} LOGIN PASSWORD ${quoteLiteral(target.password)}`,
      );
    } else {
      await admin.$executeRawUnsafe(
        `CREATE ROLE ${roleId} LOGIN PASSWORD ${quoteLiteral(target.password)}`,
      );
    }
    // The RDS master user is not a superuser: it must be a member of the
    // owner role for CREATE DATABASE ... OWNER and for schema work below.
    await admin.$executeRawUnsafe(`GRANT ${roleId} TO ${masterId}`);
    const dbExists = await admin.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(target.db)}`,
    );
    if (dbExists.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE ${dbId} OWNER ${roleId}`);
    }
    await admin.$executeRawUnsafe(
      `GRANT CONNECT ON DATABASE ${dbId} TO ${masterId}`,
    );
    await admin.$executeRawUnsafe(
      `REVOKE CONNECT ON DATABASE ${dbId} FROM PUBLIC`,
    );
    // The owner role must own the public schema for Prisma migrate.
    const appDb = createClient(url(master.user, master.password, target.db));
    try {
      await appDb.$executeRawUnsafe(`ALTER SCHEMA public OWNER TO ${roleId}`);
    } finally {
      await appDb.$disconnect();
    }
    console.log(`bootstrap: ${target.db} ready (role ${target.role})`);
  }
  await admin.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
