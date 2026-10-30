import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@docbridge/auth-core";
import { AppController } from "./app.controller";
import { jwksUrl, platformUrl } from "./config";
import { JobsController } from "./jobs/jobs.controller";
import { JobsService } from "./jobs/jobs.service";
import { PlatformClient } from "./platform/platform-client";
import { PrismaService } from "./prisma/prisma.service";
import { StagingStorage } from "./storage/staging-storage.service";
import { UploadsController } from "./uploads/uploads.controller";
import { UploadsService } from "./uploads/uploads.service";

@Module({
  imports: [AuthCoreModule.forRoot({ jwksUrl: jwksUrl() })],
  controllers: [AppController, UploadsController, JobsController],
  providers: [
    PrismaService,
    StagingStorage,
    UploadsService,
    JobsService,
    {
      provide: PlatformClient,
      useFactory: () => new PlatformClient({ baseUrl: platformUrl() }),
    },
  ],
})
export class AppModule {}
