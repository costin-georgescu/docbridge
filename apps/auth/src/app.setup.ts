import { INestApplication } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { HttpErrorFilter } from "./common/http-error.filter";
import { securityHeaders } from "./common/security-headers";
import { config } from "./config";

export function configureApp(app: INestApplication): void {
  app.use(securityHeaders);
  // X-Forwarded-For is set by the edge so req.ip is the real client for
  // the per-IP rate limits: 1 hop behind the public ALB, 2 behind
  // CloudFront -> internal ALB (TRUST_PROXY_HOPS; default 1 for local dev).
  (app as NestExpressApplication).set("trust proxy", config.TRUST_PROXY_HOPS);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpErrorFilter());
  if (config.WEB_ORIGIN) {
    app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  }
}
