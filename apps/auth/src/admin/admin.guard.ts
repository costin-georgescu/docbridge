import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Request } from "express";
import { UserClaims } from "@docbridge/contracts";
import { AppError } from "../common/app-error";
import { SigningKeyService } from "../keys/signing-key.service";

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(SigningKeyService)
    private readonly signingKey: SigningKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) {
      throw new AppError(401, "unauthorized", "Missing bearer token");
    }
    let claims: UserClaims;
    try {
      claims = UserClaims.parse(await this.signingKey.verify(token));
    } catch {
      throw new AppError(401, "unauthorized", "Invalid bearer token");
    }
    if (!claims.admin) {
      throw new AppError(403, "forbidden", "Admin access required");
    }
    return true;
  }
}
