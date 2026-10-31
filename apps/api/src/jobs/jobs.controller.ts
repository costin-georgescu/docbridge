import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  AuthenticatedRequest,
  Claims,
  RequireUser,
} from "@docbridge/auth-core";
import {
  CreateJobRequest,
  CreateJobResponse,
  JobDetailResponse,
  JobFileDownloadResponse,
  JobListQuery,
  JobListResponse,
  type UserClaims,
} from "@docbridge/contracts";
import { RateLimiterRegistry } from "@docbridge/rate-limit";
import { AppError } from "../common/app-error";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { config } from "../config";
import { JobsService } from "./jobs.service";

const MINUTE_MS = 60_000;

@Controller("api/jobs")
export class JobsController {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(RateLimiterRegistry)
    private readonly rateLimit: RateLimiterRegistry,
  ) {}

  @Post()
  @HttpCode(202)
  @RequireUser()
  createJob(
    @Claims() claims: UserClaims,
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(CreateJobRequest)) body: CreateJobRequest,
  ): Promise<CreateJobResponse> {
    if (
      !this.rateLimit.hit("jobs:create", claims.sub, {
        limit: config.RATE_LIMIT_JOBS_PER_MIN,
        windowMs: MINUTE_MS,
      })
    ) {
      throw new AppError(429, "too_many_requests", "Too many requests");
    }
    return this.jobs.createJob(claims, bearerToken(req), body);
  }

  @Get()
  @RequireUser()
  listJobs(
    @Claims() claims: UserClaims,
    @Query(new ZodValidationPipe(JobListQuery)) query: JobListQuery,
  ): Promise<JobListResponse> {
    return this.jobs.listJobs(claims, query);
  }

  @Get(":id")
  @RequireUser()
  getJob(
    @Claims() claims: UserClaims,
    @Param("id") id: string,
  ): Promise<JobDetailResponse> {
    return this.jobs.getJob(claims, id);
  }

  @Get(":id/files/:fileId/download")
  @RequireUser()
  downloadFile(
    @Claims() claims: UserClaims,
    @Param("id") id: string,
    @Param("fileId") fileId: string,
  ): Promise<JobFileDownloadResponse> {
    return this.jobs.downloadFile(claims, id, fileId);
  }
}

function bearerToken(req: AuthenticatedRequest): string {
  return req.headers.authorization!.slice("Bearer ".length);
}
