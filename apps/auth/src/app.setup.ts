import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import { HttpErrorFilter } from "./common/http-error.filter";
import { config } from "./config";

export function configureApp(app: INestApplication): void {
  app.use(cookieParser());
  app.useGlobalFilters(new HttpErrorFilter());
  if (config.WEB_ORIGIN) {
    app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  }
}
