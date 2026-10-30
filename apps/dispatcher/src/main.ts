import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { config } from "./config";

async function bootstrap() {
  const logger = new Logger("dispatcher");
  logger.log(
    `NODE_ENV=${config.NODE_ENV} AWS_ENDPOINT_URL ${config.AWS_ENDPOINT_URL ? "set" : "unset"}`,
  );
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  logger.log("started");
}

void bootstrap();
