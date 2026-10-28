import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { RequireAuthenticated } from "@docbridge/auth-core";
import {
  ResolveFoldersRequest,
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

  @Post("resolve")
  @RequireAuthenticated()
  @HttpCode(200)
  resolve(
    @Body(new ZodValidationPipe(ResolveFoldersRequest))
    body: ResolveFoldersRequest,
  ): Promise<ResolveFoldersResponse> {
    return this.folders.resolve(body.folderIds);
  }
}
