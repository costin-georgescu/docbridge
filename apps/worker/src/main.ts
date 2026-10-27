import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  await NestFactory.createApplicationContext(AppModule);
  new Logger("worker").log("started");
}

void bootstrap();
