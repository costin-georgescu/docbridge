import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import argon2 from "argon2";
import { createClient, PrismaClient } from "@docbridge/db-auth";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { REFRESH_COOKIE } from "../src/constants";

const DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn(
    "auth.e2e skipped: set AUTH_TEST_DATABASE_URL to run against Postgres",
  );
}

const ADMIN_EMAIL = "e2e-admin@e2e.test";
const USER_EMAIL = "e2e-user@e2e.test";
const DISABLED_EMAIL = "e2e-disabled@e2e.test";
const SERVICE_ID = "e2e-worker";
const SERVICE_SECRET = "e2e-worker-secret";
const PASSWORD = "password123";
const TEAM_1 = "00000000-0000-7000-8000-00000000e2e1";
const TEAM_2 = "00000000-0000-7000-8000-00000000e2e2";

function cookieValue(res: request.Response): string {
  const cookies = res.headers["set-cookie"];
  const arr = Array.isArray(cookies) ? cookies : [cookies];
  const line = arr.find(
    (c) => typeof c === "string" && c.startsWith(`${REFRESH_COOKIE}=`),
  );
  return (line as string).split(";")[0].split("=")[1];
}

run("auth e2e", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let adminId: string;
  let userId: string;

  beforeAll(async () => {
    db = createClient(DATABASE_URL!);
    const passwordHash = await argon2.hash(PASSWORD);
    const admin = await db.user.upsert({
      where: { email: ADMIN_EMAIL },
      update: { passwordHash, isAdmin: true, disabledAt: null },
      create: {
        email: ADMIN_EMAIL,
        passwordHash,
        displayName: "E2E Admin",
        isAdmin: true,
      },
    });
    adminId = admin.id;
    const user = await db.user.upsert({
      where: { email: USER_EMAIL },
      update: { passwordHash, disabledAt: null },
      create: {
        email: USER_EMAIL,
        passwordHash,
        displayName: "E2E User",
      },
    });
    userId = user.id;
    await db.teamMembership.deleteMany({ where: { userId: adminId } });
    await db.teamMembership.deleteMany({ where: { userId } });
    await db.teamMembership.createMany({
      data: [
        { userId, teamId: TEAM_1 },
        { userId, teamId: TEAM_2 },
      ],
    });
    const disabled = await db.user.upsert({
      where: { email: DISABLED_EMAIL },
      update: { passwordHash, disabledAt: new Date() },
      create: {
        email: DISABLED_EMAIL,
        passwordHash,
        displayName: "E2E Disabled",
        disabledAt: new Date(),
      },
    });
    await db.teamMembership.deleteMany({ where: { userId: disabled.id } });
    await db.serviceClient.upsert({
      where: { id: SERVICE_ID },
      update: {
        secretHash: await argon2.hash(SERVICE_SECRET),
        scopes: ["documents:write"],
      },
      create: {
        id: SERVICE_ID,
        secretHash: await argon2.hash(SERVICE_SECRET),
        scopes: ["documents:write"],
      },
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.refreshToken.deleteMany({
        where: { user: { email: { endsWith: "@e2e.test" } } },
      });
      await db.teamMembership.deleteMany({
        where: { user: { email: { endsWith: "@e2e.test" } } },
      });
      await db.user.deleteMany({ where: { email: { endsWith: "@e2e.test" } } });
      await db.serviceClient.delete({ where: { id: SERVICE_ID } });
      await db.$disconnect();
    }
  });

  it("GET /health", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);
  });

  it("login ok returns access token and strict refresh cookie", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: USER_EMAIL, password: PASSWORD })
      .expect(200);
    expect(res.body.expiresIn).toBe(900);
    const cookie = res.headers["set-cookie"].toString();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/auth");
    const [, payload] = res.body.accessToken.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.sub).toBe(userId);
    expect(claims.teams.sort()).toEqual([TEAM_1, TEAM_2].sort());
    expect(claims.admin).toBe(false);
    expect(claims.iss).toBe("docbridge-auth");
    expect(claims.aud).toBe("docbridge");
  });

  it("login with wrong password returns 401 invalid_credentials", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: USER_EMAIL, password: "wrong" })
      .expect(401);
    expect(res.body.error.code).toBe("invalid_credentials");
  });

  it("login for disabled user returns 423 account_disabled", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: DISABLED_EMAIL, password: PASSWORD })
      .expect(423);
    expect(res.body.error.code).toBe("account_disabled");
  });

  it("login throttles after 10 attempts per ip+email", async () => {
    const email = "e2e-throttle@e2e.test";
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email, password: "wrong" })
        .expect(401);
    }
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password: "wrong" })
      .expect(429);
    expect(res.body.error.code).toBe("too_many_attempts");
  });

  it("refresh rotates the cookie and reuse revokes the chain", async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post("/auth/login")
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200);
    const first = cookieValue(login);
    const refreshed = await agent.post("/auth/refresh").expect(200);
    const second = cookieValue(refreshed);
    expect(second).not.toBe(first);

    const reuse = await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${first}`)
      .expect(401);
    expect(reuse.body.error.code).toBe("invalid_refresh");

    await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${second}`)
      .expect(401);
  });

  it("logout revokes the cookie", async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post("/auth/login")
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200);
    const raw = cookieValue(login);
    await agent.post("/auth/logout").expect(204);
    await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${raw}`)
      .expect(401);
  });

  it("serves JWKS with cache-control", async () => {
    const res = await request(app.getHttpServer())
      .get("/auth/.well-known/jwks.json")
      .expect(200);
    expect(res.headers["cache-control"]).toContain("max-age=3600");
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0].kty).toBe("RSA");
    expect(res.body.keys[0].d).toBeUndefined();
  });

  it("service-token issues a scoped token and rejects bad secrets", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/service-token")
      .send({ clientId: SERVICE_ID, clientSecret: SERVICE_SECRET })
      .expect(200);
    expect(res.body.expiresIn).toBe(3600);
    const [, payload] = res.body.accessToken.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.sub).toBe(`service:${SERVICE_ID}`);
    expect(claims.scope).toEqual(["documents:write"]);

    const bad = await request(app.getHttpServer())
      .post("/auth/service-token")
      .send({ clientId: SERVICE_ID, clientSecret: "nope" })
      .expect(401);
    expect(bad.body.error.code).toBe("invalid_credentials");
  });

  it("admin user lifecycle: create, list, replace teams, disable", async () => {
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200);
    const adminToken = login.body.accessToken;
    const auth = (r: request.Test) =>
      r.set("Authorization", `Bearer ${adminToken}`);

    const created = await auth(request(app.getHttpServer()).post("/auth/users"))
      .send({
        email: "e2e-created@e2e.test",
        displayName: "Created",
        password: "password123",
        teamIds: [TEAM_1],
      })
      .expect(201);
    expect(created.body.teamIds).toEqual([TEAM_1]);

    const page1 = await auth(
      request(app.getHttpServer()).get("/auth/users?limit=1"),
    ).expect(200);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await auth(
      request(app.getHttpServer()).get(
        `/auth/users?limit=50&cursor=${page1.body.nextCursor}`,
      ),
    ).expect(200);
    const ids = [...page1.body.items, ...page2.body.items].map(
      (u: { id: string }) => u.id,
    );
    expect(ids).toContain(created.body.id);

    const replaced = await auth(
      request(app.getHttpServer()).put(`/auth/users/${created.body.id}/teams`),
    )
      .send({ teamIds: [TEAM_2] })
      .expect(200);
    expect(replaced.body.teamIds).toEqual([TEAM_2]);

    await auth(
      request(app.getHttpServer()).post(
        `/auth/users/${created.body.id}/disable`,
      ),
    ).expect(204);
    const disabledLogin = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "e2e-created@e2e.test", password: PASSWORD })
      .expect(423);
    expect(disabledLogin.body.error.code).toBe("account_disabled");
  });

  it("replace teams on unknown user returns 404 user_not_found", async () => {
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200);
    const res = await request(app.getHttpServer())
      .put("/auth/users/00000000-0000-7000-8000-0000000deadd/teams")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ teamIds: [TEAM_1] })
      .expect(404);
    expect(res.body.error.code).toBe("user_not_found");
  });

  it("admin routes reject non-admin and missing tokens", async () => {
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: USER_EMAIL, password: PASSWORD })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get("/auth/users")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .expect(403);
    expect(res.body.error.code).toBe("forbidden");

    const noToken = await request(app.getHttpServer())
      .get("/auth/users")
      .expect(401);
    expect(noToken.body.error.code).toBe("unauthorized");
  });

  it("invalid login body returns 422 validation_error in TDD shape", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "not-an-email" })
      .expect(422);
    expect(res.body.error.code).toBe("validation_error");
    expect(typeof res.body.error.message).toBe("string");
    expect(res.body.error.details.issues.length).toBeGreaterThan(0);
  });
});
