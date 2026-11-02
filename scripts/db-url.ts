import { withDbSsl } from "@docbridge/config";

// Resolves a Postgres URL for scripts. Locally the <P>_DATABASE_URL vars in
// .env win; on AWS (one-off ECS tasks) Secrets Manager can't template a full
// URL, so the task injects <P>_DB_HOST/_DB_NAME plus <P>_DB_USERNAME/
// _DB_PASSWORD from the per-database secrets — same convention the services
// use via @docbridge/config's databaseUrlFromEnv, but prefixed per database.
export function dbUrl(prefix: string): string {
  const direct = process.env[`${prefix}_DATABASE_URL`];
  if (direct) return withDbSsl(direct);
  const host = process.env[`${prefix}_DB_HOST`];
  const name = process.env[`${prefix}_DB_NAME`];
  const user = process.env[`${prefix}_DB_USERNAME`];
  const pass = process.env[`${prefix}_DB_PASSWORD`];
  if (!host || !name || !user || !pass) {
    throw new Error(
      `${prefix}_DATABASE_URL or ${prefix}_DB_HOST/${prefix}_DB_NAME/` +
        `${prefix}_DB_USERNAME/${prefix}_DB_PASSWORD must be set`,
    );
  }
  return withDbSsl(
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:5432/${name}`,
  );
}
