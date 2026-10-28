import { Inject, Injectable } from "@nestjs/common";
import { jwtVerify } from "jose";
import { TokenClaims } from "@docbridge/contracts";
import { AUDIENCE, ISSUER } from "./constants";
import { JwksClient } from "./jwks-client";

@Injectable()
export class TokenVerifier {
  constructor(@Inject(JwksClient) private readonly jwks: JwksClient) {}

  async verify(token: string): Promise<TokenClaims> {
    const { payload } = await jwtVerify(token, this.jwks.keyResolver, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["RS256"],
    });
    return TokenClaims.parse(payload);
  }
}
