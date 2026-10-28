import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  exportJWK,
  generateKeyPair,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
  type CryptoKey,
} from "jose";
import { randomBytes } from "node:crypto";
import { AUDIENCE, ISSUER } from "../constants";
import { config } from "../config";

const PUBLIC_JWK_FIELDS = ["kty", "n", "e"] as const;

@Injectable()
export class SigningKeyService implements OnModuleInit {
  private readonly logger = new Logger(SigningKeyService.name);
  private privateKey!: CryptoKey;
  private publicJwk!: JWK;

  async onModuleInit(): Promise<void> {
    if (config.JWT_SIGNING_KEY) {
      const parsed = JSON.parse(config.JWT_SIGNING_KEY) as {
        kid: string;
        privateKey: string;
      };
      const key = await importPKCS8(parsed.privateKey, "RS256");
      this.privateKey = key;
      this.publicJwk = await this.toPublicJwk(key, parsed.kid);
      return;
    }
    if (config.NODE_ENV === "production") {
      throw new Error("JWT_SIGNING_KEY must be set in production");
    }
    this.logger.warn("JWT_SIGNING_KEY unset; using an ephemeral keypair");
    const pair = await generateKeyPair("RS256", {
      modulusLength: 2048,
      extractable: true,
    });
    this.privateKey = pair.privateKey as CryptoKey;
    this.publicJwk = await this.toPublicJwk(
      pair.privateKey as CryptoKey,
      `dev-${randomBytes(4).toString("hex")}`,
    );
  }

  private async toPublicJwk(privateKey: CryptoKey, kid: string): Promise<JWK> {
    const jwk = await exportJWK(privateKey);
    const pub: JWK = {};
    for (const field of PUBLIC_JWK_FIELDS) {
      if (jwk[field] !== undefined) pub[field] = jwk[field];
    }
    pub.kid = kid;
    pub.alg = "RS256";
    pub.use = "sig";
    return pub;
  }

  async sign(
    payload: Record<string, unknown>,
    ttlSeconds: number,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(payload as JWTPayload)
      .setProtectedHeader({ alg: "RS256", kid: this.publicJwk.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .sign(this.privateKey);
  }

  async verify(token: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.publicJwk, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return payload;
  }

  jwks(): { keys: JWK[] } {
    return { keys: [this.publicJwk] };
  }
}
