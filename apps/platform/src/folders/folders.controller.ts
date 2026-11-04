import { Controller, Get, Inject, Query } from "@nestjs/common";
import { Claims, RequireAuthenticated } from "@docbridge/auth-core";
import {
  ResolveFoldersQuery,
  ResolveFoldersResponse,
  TokenClaims,
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
    @Claims() claims: TokenClaims,
    @Query(new ZodValidationPipe(ResolveFoldersQuery))
    query: ResolveFoldersQuery,
  ): Promise<ResolveFoldersResponse> {
    // User tokens resolve only inside their own teams — a cross-team folder
    // id reports as missing so the endpoint can't be used to map another
    // team's hierarchy. Service tokens stay unscoped for internal callers.
    return this.folders.resolve(
      query.ids,
      "teams" in claims ? claims.teams : undefined,
    );
  }
}
