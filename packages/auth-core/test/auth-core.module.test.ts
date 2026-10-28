import { afterAll, describe, expect, it } from "@jest/globals";
import { Controller, Get, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AuthCoreModule } from "../src/auth-core.module";
import { Claims, RequireUser } from "../src/decorators";
import { fakeFetch, makeKeypair, signToken, userPayload } from "./helpers";
import type { TokenClaims } from "@docbridge/contracts";

const JWKS_URL = "http://auth.test/.well-known/jwks.json";

@Controller()
class WarmUpController {
  @Get("/user")
  @RequireUser()
  user(@Claims() claims: TokenClaims) {
    return claims;
  }
}

describe("AuthCoreModule", () => {
  let app: INestApplication;

  afterAll(async () => {
    await app?.close();
  });

  it("boots even when the initial JWKS fetch fails, then recovers", async () => {
    const kp = await makeKeypair("k1");
    let fail = true;
    const { fetch, calls } = fakeFetch(() => {
      if (fail) throw new Error("connection refused");
      return [kp.publicJwk];
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthCoreModule.forRoot({
          jwksUrl: JWKS_URL,
          fetch,
          cooldownMs: 0,
        }),
      ],
      controllers: [WarmUpController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    expect(calls.length).toBeGreaterThanOrEqual(1);

    fail = false;
    const token = await signToken(kp.privateKey, "k1", userPayload());
    const res = await request(app.getHttpServer())
      .get("/user")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.sub).toBe("11111111-2222-3333-a444-555555555555");
  });
});
