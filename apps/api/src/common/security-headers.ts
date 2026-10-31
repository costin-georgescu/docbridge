import { NextFunction, Request, Response } from "express";

/**
 * TDD 5.5: hardening headers on service responses. The web bundle gets its
 * own set from the CloudFront response headers policy; requests to
 * api.<domain> reach these apps through the ALB with no header layer in
 * between. Route-level @Header values still win (e.g. the JWKS cache TTL).
 */
export function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  res.setHeader("Cache-Control", "no-store");
  next();
}
