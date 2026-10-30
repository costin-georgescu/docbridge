import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@docbridge/auth-core";
import { AppController } from "./app.controller";
import { jwksUrl } from "./config";
import { AdminController } from "./admin/admin.controller";
import { AdminService } from "./admin/admin.service";
import { DocumentsController } from "./documents/documents.controller";
import { DocumentsService } from "./documents/documents.service";
import { FoldersController } from "./folders/folders.controller";
import { FoldersService } from "./folders/folders.service";
import { PrismaService } from "./prisma/prisma.service";
import { PlatformStorage } from "./storage/platform-storage.service";
import { TreeController } from "./tree/tree.controller";
import { TreeService } from "./tree/tree.service";

@Module({
  imports: [AuthCoreModule.forRoot({ jwksUrl: jwksUrl() })],
  controllers: [
    AppController,
    TreeController,
    FoldersController,
    DocumentsController,
    AdminController,
  ],
  providers: [
    PrismaService,
    PlatformStorage,
    TreeService,
    FoldersService,
    DocumentsService,
    AdminService,
  ],
})
export class AppModule {}
