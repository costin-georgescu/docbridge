import { Controller, Get, Inject, Ip, Query } from "@nestjs/common";
import { Claims, RequireUser } from "@docbridge/auth-core";
import { RateLimiterRegistry } from "@docbridge/rate-limit";
import { TreeQuery, TreeResponse, type UserClaims } from "@docbridge/contracts";
import { AppError } from "../common/app-error";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { config } from "../config";
import { TreeService } from "./tree.service";

const MINUTE_MS = 60_000;

@Controller()
export class TreeController {
  constructor(
    @Inject(TreeService)
    private readonly tree: TreeService,
    @Inject(RateLimiterRegistry)
    private readonly rateLimit: RateLimiterRegistry,
  ) {}

  @Get("tree")
  @RequireUser()
  getTree(
    @Claims() claims: UserClaims,
    @Ip() ip: string,
    @Query(new ZodValidationPipe(TreeQuery)) query: TreeQuery,
  ): Promise<TreeResponse> {
    if (
      !this.rateLimit.hit("tree:read", ip ?? "", {
        limit: config.RATE_LIMIT_TREE_PER_MIN,
        windowMs: MINUTE_MS,
      })
    ) {
      throw new AppError(429, "too_many_requests", "Too many requests");
    }
    if (query.all && !claims.admin) {
      throw new AppError(403, "forbidden", "Admin access required");
    }
    return this.tree.getTree(
      query.all ? { all: true } : { teamIds: claims.teams },
    );
  }
}
