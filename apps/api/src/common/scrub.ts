const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * TDD 5.5: emails and credentials never reach the logs. Redacts
 * email-shaped text and token-shaped strings (JWTs, Bearer headers)
 * from an exception string before it is logged; an unhandled error's
 * message can echo request data (e.g. a Prisma validation message).
 * File names and object keys are kept out at the call sites — the
 * scrubber cannot distinguish a name from an id-shaped token.
 */
export function scrubForLog(text: string): string {
  return text
    .replace(JWT_RE, "[token]")
    .replace(BEARER_RE, "Bearer [token]")
    .replace(EMAIL_RE, "[email]");
}
