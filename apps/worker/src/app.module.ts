import { Module } from "@nestjs/common";
import { ServiceTokens } from "./auth/service-tokens";
import { config } from "./config";
import { PlatformDeliveryClient } from "./platform/platform-client";
import { PrismaService } from "./prisma/prisma.service";
import { SqsService } from "./sqs/sqs.service";
import { StagingStorage } from "./storage/staging-storage.service";
import { TaskPoller } from "./tasks/task-poller";
import { TaskProcessor } from "./tasks/task-processor";

@Module({
  providers: [
    PrismaService,
    SqsService,
    StagingStorage,
    {
      provide: ServiceTokens,
      useFactory: () =>
        new ServiceTokens({
          baseUrl: config.AUTH_INTERNAL_URL,
          clientId: config.WORKER_CLIENT_ID,
          clientSecret: config.WORKER_CLIENT_SECRET,
        }),
    },
    {
      provide: PlatformDeliveryClient,
      useFactory: () =>
        new PlatformDeliveryClient({ baseUrl: config.PLATFORM_INTERNAL_URL }),
    },
    TaskProcessor,
    TaskPoller,
  ],
})
export class AppModule {}
