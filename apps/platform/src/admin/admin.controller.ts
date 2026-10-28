import { Body, Controller, Inject, Post } from "@nestjs/common";
import { RequireAdmin } from "@docbridge/auth-core";
import {
  BinderResponse,
  CreateBinderRequest,
  CreateFolderRequest,
  CreateTeamRequest,
  FolderResponse,
  TeamResponse,
} from "@docbridge/contracts";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AdminService } from "./admin.service";

@Controller("admin")
@RequireAdmin()
export class AdminController {
  constructor(
    @Inject(AdminService)
    private readonly admin: AdminService,
  ) {}

  @Post("teams")
  createTeam(
    @Body(new ZodValidationPipe(CreateTeamRequest)) body: CreateTeamRequest,
  ): Promise<TeamResponse> {
    return this.admin.createTeam(body);
  }

  @Post("binders")
  createBinder(
    @Body(new ZodValidationPipe(CreateBinderRequest)) body: CreateBinderRequest,
  ): Promise<BinderResponse> {
    return this.admin.createBinder(body);
  }

  @Post("folders")
  createFolder(
    @Body(new ZodValidationPipe(CreateFolderRequest)) body: CreateFolderRequest,
  ): Promise<FolderResponse> {
    return this.admin.createFolder(body);
  }
}
