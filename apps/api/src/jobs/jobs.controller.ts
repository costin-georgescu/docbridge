import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
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
  type UserClaims,
} from "@docbridge/contracts";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { JobsService } from "./jobs.service";

@Controller("api/jobs")
export class JobsController {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  @Post()
  @HttpCode(202)
  @RequireUser()
  createJob(
    @Claims() claims: UserClaims,
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(CreateJobRequest)) body: CreateJobRequest,
  ): Promise<CreateJobResponse> {
    return this.jobs.createJob(claims, bearerToken(req), body);
  }
}

function bearerToken(req: AuthenticatedRequest): string {
  return req.headers.authorization!.slice("Bearer ".length);
}
