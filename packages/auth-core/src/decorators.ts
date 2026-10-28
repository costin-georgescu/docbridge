import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, AuthenticatedRequest } from "./auth.guard";
import { AUTH_REQUIREMENT } from "./requirement";

export function RequireUser() {
  return applyDecorators(
    SetMetadata(AUTH_REQUIREMENT, { kind: "user" }),
    UseGuards(AuthGuard),
  );
}

export function RequireAdmin() {
  return applyDecorators(
    SetMetadata(AUTH_REQUIREMENT, { kind: "admin" }),
    UseGuards(AuthGuard),
  );
}

export function RequireService(...scopes: [string, ...string[]]) {
  return applyDecorators(
    SetMetadata(AUTH_REQUIREMENT, { kind: "service", scopes }),
    UseGuards(AuthGuard),
  );
}

export const Claims = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().claims,
);
