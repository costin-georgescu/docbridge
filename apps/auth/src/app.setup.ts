import { INestApplication } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { HttpErrorFilter } from "./common/http-error.filter";
import { securityHeaders } from "./common/security-headers";
import { config } from "./config";

export function configureApp(app: INestApplication): void {
  app.use(securityHeaders);
  // One trusted proxy hop: the ALB sets X-Forwarded-For, so req.ip is the
  // real client address for the per-IP rate limits.
  (app as NestExpressApplication).set("trust proxy", 1);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpErrorFilter());
  if (config.WEB_ORIGIN) {
    app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  }
}
