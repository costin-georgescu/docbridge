import {
  Body,
  Inject,
  Controller,
  Get,
  Header,
  HttpCode,
  Ip,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { Request, Response } from "express";
import {
  LoginRequest,
  ServiceTokenRequest,
  TokenResponse,
} from "@docbridge/contracts";
import { RateLimiterRegistry } from "@docbridge/rate-limit";
import {
  ACCESS_TOKEN_TTL_S,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_S,
  SERVICE_TOKEN_TTL_S,
} from "../constants";
import { AppError } from "../common/app-error";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { config } from "../config";
import { LoginThrottleService } from "../throttle/login-throttle.service";
import { SigningKeyService } from "../keys/signing-key.service";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService)
    private readonly auth: AuthService,
    @Inject(LoginThrottleService)
    private readonly throttle: LoginThrottleService,
    @Inject(SigningKeyService)
    private readonly signingKey: SigningKeyService,
    @Inject(RateLimiterRegistry)
    private readonly rateLimit: RateLimiterRegistry,
  ) {}

  private checkRateLimit(bucket: string, ip: string, limit: number): void {
    if (!this.rateLimit.hit(bucket, ip, { limit, windowMs: 60_000 })) {
      throw new AppError(429, "too_many_requests", "Too many requests");
    }
  }

  private setRefreshCookie(res: Response, raw: string): void {
    res.cookie(REFRESH_COOKIE, raw, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.NODE_ENV === "production",
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_S * 1000,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  }

  @Post("login")
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponse> {
    if (!this.throttle.hit(this.throttle.keyFor(ip, body.email))) {
      throw new AppError(429, "too_many_attempts", "Too many attempts");
    }
    const { accessToken, refresh } = await this.auth.login(
      body.email,
      body.password,
    );
    this.setRefreshCookie(res, refresh.raw);
    return { accessToken, expiresIn: ACCESS_TOKEN_TTL_S };
  }

  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponse> {
    this.checkRateLimit(
      "session",
      req.ip ?? "",
      config.RATE_LIMIT_SESSION_PER_MIN,
    );
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!raw) {
      throw new AppError(401, "invalid_refresh", "Invalid refresh token");
    }
    try {
      const { accessToken, refresh } = await this.auth.refresh(raw);
      this.setRefreshCookie(res, refresh.raw);
      return { accessToken, expiresIn: ACCESS_TOKEN_TTL_S };
    } catch (err) {
      if (err instanceof AppError) this.clearRefreshCookie(res);
      throw err;
    }
  }

  @Post("logout")
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.checkRateLimit(
      "session",
      req.ip ?? "",
      config.RATE_LIMIT_SESSION_PER_MIN,
    );
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (raw) {
      await this.auth.logout(raw);
    }
    this.clearRefreshCookie(res);
  }

  @Get(".well-known/jwks.json")
  @Header("Cache-Control", "public, max-age=3600")
  jwks(): { keys: unknown[] } {
    return this.signingKey.jwks();
  }

  @Post("service-token")
  @HttpCode(200)
  async serviceToken(
    @Body(new ZodValidationPipe(ServiceTokenRequest))
    body: ServiceTokenRequest,
    @Ip() ip: string,
  ): Promise<TokenResponse> {
    this.checkRateLimit(
      "serviceToken",
      ip ?? "",
      config.RATE_LIMIT_SERVICE_TOKEN_PER_MIN,
    );
    const accessToken = await this.auth.serviceToken(
      body.clientId,
      body.clientSecret,
    );
    return { accessToken, expiresIn: SERVICE_TOKEN_TTL_S };
  }
}
