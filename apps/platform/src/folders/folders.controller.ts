import { Controller, Get, Inject, Query } from "@nestjs/common";
import { RequireAuthenticated } from "@docbridge/auth-core";
import {
  ResolveFoldersQuery,
  ResolveFoldersResponse,
} from "@docbridge/contracts";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { FoldersService } from "./folders.service";

@Controller("folders")
export class FoldersController {
  constructor(
    @Inject(FoldersService)
    private readonly folders: FoldersService,
  ) {}

  @Get()
  @RequireAuthenticated()
  resolve(
    @Query(new ZodValidationPipe(ResolveFoldersQuery))
    query: ResolveFoldersQuery,
  ): Promise<ResolveFoldersResponse> {
    return this.folders.resolve(query.ids);
  }
}
