import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import { config } from "./config";

async function bootstrap() {
  const logger = new Logger("platform");
  logger.log(
    `NODE_ENV=${config.NODE_ENV} AWS_ENDPOINT_URL ${config.AWS_ENDPOINT_URL ? "set" : "unset"}`,
  );
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(config.PORT);
}

void bootstrap();
