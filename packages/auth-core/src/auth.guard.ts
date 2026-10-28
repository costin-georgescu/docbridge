import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { TokenClaims } from "@docbridge/contracts";
import { AuthError } from "./errors";
import { AUTH_REQUIREMENT, AuthRequirement } from "./requirement";
import { TokenVerifier } from "./token-verifier";

export interface AuthenticatedRequest extends Request {
  claims: TokenClaims;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<AuthRequirement>(
      AUTH_REQUIREMENT,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement) {
      return true;
    }
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) {
      throw new AuthError(401, "unauthorized", "Missing bearer token");
    }
    let claims: TokenClaims;
    try {
      claims = await this.verifier.verify(token);
    } catch {
      throw new AuthError(401, "unauthorized", "Invalid bearer token");
    }
    this.checkRequirement(requirement, claims);
    req.claims = claims;
    return true;
  }

  private checkRequirement(
    requirement: AuthRequirement,
    claims: TokenClaims,
  ): void {
    switch (requirement.kind) {
      case "any":
        return;
      case "user":
        if (!("teams" in claims)) {
          throw new AuthError(403, "forbidden", "User token required");
        }
        return;
      case "admin":
        if (!("teams" in claims)) {
          throw new AuthError(403, "forbidden", "User token required");
        }
        if (claims.admin !== true) {
          throw new AuthError(403, "forbidden", "Admin access required");
        }
        return;
      case "service":
        if (!("scope" in claims)) {
          throw new AuthError(403, "forbidden", "Service token required");
        }
        if (!requirement.scopes.every((s) => claims.scope.includes(s))) {
          throw new AuthError(403, "forbidden", "Insufficient scope");
        }
        return;
    }
  }
}
