import { Controller, Get, Inject, Query } from "@nestjs/common";
import { Claims, RequireUser } from "@docbridge/auth-core";
import {
  TreeQuery,
  TreeResponse,
  type UserClaims,
} from "@docbridge/contracts";
import { AppError } from "../common/app-error";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TreeService } from "./tree.service";

@Controller()
export class TreeController {
  constructor(
    @Inject(TreeService)
    private readonly tree: TreeService,
  ) {}

  @Get("tree")
  @RequireUser()
  getTree(
    @Claims() claims: UserClaims,
    @Query(new ZodValidationPipe(TreeQuery)) query: TreeQuery,
  ): Promise<TreeResponse> {
    if (query.all && !claims.admin) {
      throw new AppError(403, "forbidden", "Admin access required");
    }
    return this.tree.getTree(
      query.all ? { all: true } : { teamIds: claims.teams },
    );
  }
}
