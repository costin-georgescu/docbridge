import { Module } from "@nestjs/common";
import { RateLimiterRegistry } from "@docbridge/rate-limit";
import { AppController } from "./app.controller";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { AdminGuard } from "./admin/admin.guard";
import { UsersController } from "./admin/users.controller";
import { UsersService } from "./admin/users.service";
import { SigningKeyService } from "./keys/signing-key.service";
import { PrismaService } from "./prisma/prisma.service";
import { LoginThrottleService } from "./throttle/login-throttle.service";
import { RefreshTokenService } from "./tokens/refresh-token.service";
import { TokenService } from "./tokens/token.service";

@Module({
  controllers: [AppController, AuthController, UsersController],
  providers: [
    PrismaService,
    SigningKeyService,
    TokenService,
    RefreshTokenService,
    LoginThrottleService,
    RateLimiterRegistry,
    AuthService,
    AdminGuard,
    UsersService,
  ],
})
export class AppModule {}
