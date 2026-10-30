import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service";
import { StagingStorage } from "./storage/staging-storage.service";
import { SqsService } from "./sqs/sqs.service";
import { StagingConfirmer } from "./upload-events/staging-confirmer";
import { UploadEventsConsumer } from "./upload-events/upload-events.consumer";
import { ReconciliationSweep } from "./upload-events/reconciliation.sweep";
import { TaskPublisher } from "./tasks/task-publisher";

@Module({
  providers: [
    PrismaService,
    StagingStorage,
    SqsService,
    StagingConfirmer,
    UploadEventsConsumer,
    ReconciliationSweep,
    TaskPublisher,
  ],
})
export class AppModule {}
