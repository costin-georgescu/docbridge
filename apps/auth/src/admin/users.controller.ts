import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  CreateUserRequest,
  ReplaceTeamsRequest,
  UserListQuery,
  UserListResponse,
  UserResponse,
} from "@docbridge/contracts";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AdminGuard } from "./admin.guard";
import { UsersService } from "./users.service";

const UserId = z.uuid();

@Controller("auth/users")
@UseGuards(AdminGuard)
export class UsersController {
  constructor(
    @Inject(UsersService)
    private readonly users: UsersService,
  ) {}

  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateUserRequest)) body: CreateUserRequest,
  ): Promise<UserResponse> {
    return this.users.create(body);
  }

  @Get()
  async list(
    @Query(new ZodValidationPipe(UserListQuery)) query: UserListQuery,
  ): Promise<UserListResponse> {
    return this.users.list(query.cursor, query.limit);
  }

  @Put(":id/teams")
  async replaceTeams(
    @Param("id", new ZodValidationPipe(UserId)) id: string,
    @Body(new ZodValidationPipe(ReplaceTeamsRequest)) body: ReplaceTeamsRequest,
  ): Promise<UserResponse> {
    return this.users.replaceTeams(id, body.teamIds);
  }

  @Post(":id/disable")
  @HttpCode(204)
  async disable(
    @Param("id", new ZodValidationPipe(UserId)) id: string,
  ): Promise<void> {
    await this.users.disable(id);
  }
}
