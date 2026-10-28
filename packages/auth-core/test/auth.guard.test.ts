import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { Controller, Get, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AuthCoreModule } from "../src/auth-core.module";
import { Claims } from "../src/decorators";
import { RequireAdmin, RequireService, RequireUser } from "../src/decorators";
import {
  fakeFetch,
  makeKeypair,
  servicePayload,
  signToken,
  TestKeypair,
  userPayload,
} from "./helpers";
import type { TokenClaims } from "@docbridge/contracts";

const JWKS_URL = "http://auth.test/.well-known/jwks.json";

@Controller()
class TestController {
  @Get("/user")
  @RequireUser()
  user(@Claims() claims: TokenClaims) {
    return claims;
  }

  @Get("/admin")
  @RequireAdmin()
  admin(@Claims() claims: TokenClaims) {
    return claims;
  }

  @Get("/service")
  @RequireService("documents:write")
  service(@Claims() claims: TokenClaims) {
    return claims;
  }

  @Get("/open")
  open() {
    return { ok: true };
  }
}

describe("AuthGuard", () => {
  let app: INestApplication;
  let kp: TestKeypair;
  let calls: { url: string }[];

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    kp = await makeKeypair("k1");
    const fake = fakeFetch(() => [kp.publicJwk]);
    calls = fake.calls;
    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthCoreModule.forRoot({ jwksUrl: JWKS_URL, fetch: fake.fetch }),
      ],
      controllers: [TestController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("allows open routes without a token", async () => {
    await request(app.getHttpServer()).get("/open").expect(200);
  });

  it("rejects a missing token with 401", async () => {
    const res = await request(app.getHttpServer()).get("/user").expect(401);
    expect(res.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Missing bearer token",
        details: {},
      },
    });
  });

  it("rejects a garbage token with 401", async () => {
    const res = await request(app.getHttpServer())
      .get("/user")
      .set(bearer("not-a-jwt"))
      .expect(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects a non-Bearer authorization header", async () => {
    await request(app.getHttpServer())
      .get("/user")
      .set("Authorization", "Basic xyz")
      .expect(401);
  });

  it("returns the user claims for a valid user token", async () => {
    const token = await signToken(kp.privateKey, "k1", userPayload());
    const res = await request(app.getHttpServer())
      .get("/user")
      .set(bearer(token))
      .expect(200);
    expect(res.body.sub).toBe("11111111-2222-3333-a444-555555555555");
    expect(res.body.teams).toEqual(["66666666-7777-4888-8999-000000000000"]);
  });

  it("rejects a service token on a user route with 403", async () => {
    const token = await signToken(kp.privateKey, "k1", servicePayload());
    const res = await request(app.getHttpServer())
      .get("/user")
      .set(bearer(token))
      .expect(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("rejects a non-admin user on an admin route", async () => {
    const token = await signToken(kp.privateKey, "k1", userPayload());
    await request(app.getHttpServer())
      .get("/admin")
      .set(bearer(token))
      .expect(403);
  });

  it("allows an admin user on an admin route", async () => {
    const token = await signToken(
      kp.privateKey,
      "k1",
      userPayload({ admin: true }),
    );
    const res = await request(app.getHttpServer())
      .get("/admin")
      .set(bearer(token))
      .expect(200);
    expect(res.body.admin).toBe(true);
  });

  it("rejects a user token on a service route", async () => {
    const token = await signToken(kp.privateKey, "k1", userPayload());
    await request(app.getHttpServer())
      .get("/service")
      .set(bearer(token))
      .expect(403);
  });

  it("allows a service token with the required scope", async () => {
    const token = await signToken(
      kp.privateKey,
      "k1",
      servicePayload(["documents:write"]),
    );
    const res = await request(app.getHttpServer())
      .get("/service")
      .set(bearer(token))
      .expect(200);
    expect(res.body.sub).toBe("service:worker");
  });

  it("rejects a service token missing the required scope", async () => {
    const token = await signToken(
      kp.privateKey,
      "k1",
      servicePayload(["other"]),
    );
    const res = await request(app.getHttpServer())
      .get("/service")
      .set(bearer(token))
      .expect(403);
    expect(res.body.error).toMatchObject({
      code: "forbidden",
      message: "Insufficient scope",
    });
  });

  it("fetched the JWKS once at startup", () => {
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
