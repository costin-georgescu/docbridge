import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { Claims, RequireUser } from "@docbridge/auth-core";
import {
  CompleteUploadRequest,
  CompleteUploadResponse,
  CreateUploadRequest,
  CreateUploadResponse,
  UploadStatusQuery,
  UploadStatusResponse,
  type UserClaims,
} from "@docbridge/contracts";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { UploadsService } from "./uploads.service";

@Controller("api/uploads")
export class UploadsController {
  constructor(
    @Inject(UploadsService)
    private readonly uploads: UploadsService,
  ) {}

  @Post()
  @RequireUser()
  createUpload(
    @Claims() claims: UserClaims,
    @Body(new ZodValidationPipe(CreateUploadRequest)) body: CreateUploadRequest,
  ): Promise<CreateUploadResponse> {
    return this.uploads.createUpload(claims.sub, body);
  }

  @Post(":fileId/complete")
  @HttpCode(200)
  @RequireUser()
  completeUpload(
    @Claims() claims: UserClaims,
    @Param("fileId") fileId: string,
    @Body(new ZodValidationPipe(CompleteUploadRequest))
    body: CompleteUploadRequest,
  ): Promise<CompleteUploadResponse> {
    return this.uploads.completeUpload(fileId, claims.sub, body);
  }

  @Get()
  @RequireUser()
  uploadStatus(
    @Claims() claims: UserClaims,
    @Query(new ZodValidationPipe(UploadStatusQuery)) query: UploadStatusQuery,
  ): Promise<UploadStatusResponse> {
    return this.uploads.uploadStatus(claims.sub, query.ids);
  }
}
