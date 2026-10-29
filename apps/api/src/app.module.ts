import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@docbridge/auth-core";
import { AppController } from "./app.controller";
import { jwksUrl } from "./config";
import { PrismaService } from "./prisma/prisma.service";
import { StagingStorage } from "./storage/staging-storage.service";
import { UploadsController } from "./uploads/uploads.controller";
import { UploadsService } from "./uploads/uploads.service";

@Module({
  imports: [AuthCoreModule.forRoot({ jwksUrl: jwksUrl() })],
  controllers: [AppController, UploadsController],
  providers: [PrismaService, StagingStorage, UploadsService],
})
export class AppModule {}
