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
import { RateLimiterRegistry } from "@docbridge/rate-limit";
import { AppError } from "../common/app-error";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { config } from "../config";
import { UploadsService } from "./uploads.service";

const MINUTE_MS = 60_000;

@Controller("api/uploads")
export class UploadsController {
  constructor(
    @Inject(UploadsService)
    private readonly uploads: UploadsService,
    @Inject(RateLimiterRegistry)
    private readonly rateLimit: RateLimiterRegistry,
  ) {}

  // TDD 5.5: create and complete share one 120/min per-user budget —
  // together they are "the upload endpoints".
  private checkRateLimit(userId: string): void {
    if (
      !this.rateLimit.hit("uploads", userId, {
        limit: config.RATE_LIMIT_UPLOADS_PER_MIN,
        windowMs: MINUTE_MS,
      })
    ) {
      throw new AppError(429, "too_many_requests", "Too many requests");
    }
  }

  @Post()
  @RequireUser()
  createUpload(
    @Claims() claims: UserClaims,
    @Body(new ZodValidationPipe(CreateUploadRequest)) body: CreateUploadRequest,
  ): Promise<CreateUploadResponse> {
    this.checkRateLimit(claims.sub);
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
    this.checkRateLimit(claims.sub);
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
