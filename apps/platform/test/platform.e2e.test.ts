import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { createClient, PrismaClient } from "@docbridge/db-platform";
import {
  bootApp,
  makeKeypair,
  servicePayload,
  signToken,
  TestKeypair,
  userPayload,
} from "./helpers";

const DATABASE_URL = process.env.PLATFORM_TEST_DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn(
    "platform.e2e skipped: set PLATFORM_TEST_DATABASE_URL to run against Postgres",
  );
}

const TEAM_A = "00000000-0000-7000-8000-00000000e2a1";
const TEAM_B = "00000000-0000-7000-8000-00000000e2a2";
const BINDER_A = "00000000-0000-7000-8000-00000000e2b1";
const BINDER_B = "00000000-0000-7000-8000-00000000e2b2";
const INBOX_A = "00000000-0000-7000-8000-00000000e2f1";
const ARCHIVE_A = "00000000-0000-7000-8000-00000000e2f2";
const REPORTS_A = "00000000-0000-7000-8000-00000000e2f3";
const INBOX_B = "00000000-0000-7000-8000-00000000e2f4";

run("platform e2e", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let kp: TestKeypair;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const userToken = (overrides: Record<string, unknown> = {}) =>
    signToken(kp.privateKey, kp.kid, userPayload(overrides));
  const serviceToken = () =>
    signToken(kp.privateKey, kp.kid, servicePayload());

  async function cleanPerfRows() {
    const perfTeams = await db.team.findMany({
      where: { name: { startsWith: "perf-" } },
      select: { id: true },
    });
    const perfTeamIds = perfTeams.map((t) => t.id);
    await db.folder.deleteMany({
      where: { binder: { teamId: { in: perfTeamIds } } },
    });
    await db.binder.deleteMany({ where: { teamId: { in: perfTeamIds } } });
    await db.team.deleteMany({ where: { id: { in: perfTeamIds } } });
  }

  beforeAll(async () => {
    db = createClient(DATABASE_URL!);
    await db.folder.deleteMany({
      where: { binder: { teamId: { in: [TEAM_A, TEAM_B] } } },
    });
    await db.binder.deleteMany({ where: { teamId: { in: [TEAM_A, TEAM_B] } } });
    await db.team.deleteMany({ where: { id: { in: [TEAM_A, TEAM_B] } } });
    await db.team.createMany({
      data: [
        { id: TEAM_A, name: "E2E A" },
        { id: TEAM_B, name: "E2E B" },
      ],
    });
    await db.binder.createMany({
      data: [
        { id: BINDER_A, teamId: TEAM_A, name: "Binder" },
        { id: BINDER_B, teamId: TEAM_B, name: "Binder" },
      ],
    });
    await db.folder.createMany({
      data: [
        { id: INBOX_A, binderId: BINDER_A, name: "Inbox" },
        {
          id: ARCHIVE_A,
          binderId: BINDER_A,
          parentFolderId: INBOX_A,
          name: "Archive",
        },
        { id: REPORTS_A, binderId: BINDER_A, name: "Reports" },
        { id: INBOX_B, binderId: BINDER_B, name: "Inbox" },
      ],
    });
    kp = await makeKeypair("k1");
    app = await bootApp(kp);
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanPerfRows();
      await db.folder.deleteMany({
        where: { binder: { teamId: { in: [TEAM_A, TEAM_B] } } },
      });
      await db.binder.deleteMany({
        where: { teamId: { in: [TEAM_A, TEAM_B] } },
      });
      await db.team.deleteMany({ where: { id: { in: [TEAM_A, TEAM_B] } } });
      await db.folder.deleteMany({
        where: { binder: { team: { name: "E2E New Team" } } },
      });
      await db.binder.deleteMany({
        where: { team: { name: "E2E New Team" } },
      });
      await db.team.deleteMany({ where: { name: "E2E New Team" } });
      await db.$disconnect();
    }
  });

  it("rejects GET /tree without a token", async () => {
    const res = await request(app.getHttpServer()).get("/tree").expect(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns only the user's teams with nested folders", async () => {
    const token = await userToken({ teams: [TEAM_A] });
    const res = await request(app.getHttpServer())
      .get("/tree")
      .set(bearer(token))
      .expect(200);
    expect(res.body.teams).toHaveLength(1);
    expect(res.body.teams[0]).toMatchObject({ id: TEAM_A, name: "E2E A" });
    const folders = res.body.teams[0].binders[0].folders;
    expect(folders.map((f: { name: string }) => f.name)).toEqual([
      "Inbox",
      "Reports",
    ]);
    expect(folders[0].folders).toEqual([
      { id: ARCHIVE_A, name: "Archive", folders: [] },
    ]);
  });

  it("returns an empty tree for a user with no teams", async () => {
    const token = await userToken({ teams: [] });
    const res = await request(app.getHttpServer())
      .get("/tree")
      .set(bearer(token))
      .expect(200);
    expect(res.body).toEqual({ teams: [] });
  });

  it("rejects ?all=true for a non-admin user", async () => {
    const token = await userToken({ teams: [TEAM_A] });
    const res = await request(app.getHttpServer())
      .get("/tree?all=true")
      .set(bearer(token))
      .expect(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("returns every team for an admin with ?all=true", async () => {
    const token = await userToken({ admin: true, teams: [] });
    const res = await request(app.getHttpServer())
      .get("/tree?all=true")
      .set(bearer(token))
      .expect(200);
    const ids = res.body.teams.map((t: { id: string }) => t.id);
    expect(ids).toContain(TEAM_A);
    expect(ids).toContain(TEAM_B);
  });

  it("resolves folder paths for a service token", async () => {
    const missingId = randomUUID();
    const token = await serviceToken();
    const res = await request(app.getHttpServer())
      .post("/folders/resolve")
      .set(bearer(token))
      .send({ folderIds: [ARCHIVE_A, missingId] })
      .expect(200);
    expect(res.body.resolved).toEqual([
      {
        folderId: ARCHIVE_A,
        teamId: TEAM_A,
        path: "E2E A / Binder / Inbox / Archive",
      },
    ]);
    expect(res.body.missing).toEqual([missingId]);
  });

  it("resolves folder paths for a user token", async () => {
    const token = await userToken({ teams: [TEAM_A] });
    const res = await request(app.getHttpServer())
      .post("/folders/resolve")
      .set(bearer(token))
      .send({ folderIds: [REPORTS_A] })
      .expect(200);
    expect(res.body.resolved[0].path).toBe("E2E A / Binder / Reports");
  });

  it("rejects /folders/resolve without a token", async () => {
    const res = await request(app.getHttpServer())
      .post("/folders/resolve")
      .send({ folderIds: [ARCHIVE_A] })
      .expect(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("admin can create a team", async () => {
    const token = await userToken({ admin: true });
    const res = await request(app.getHttpServer())
      .post("/admin/teams")
      .set(bearer(token))
      .send({ name: "E2E New Team" })
      .expect(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.createdAt).toBeDefined();
  });

  it("returns 404 team_not_found for a binder in an unknown team", async () => {
    const token = await userToken({ admin: true });
    const res = await request(app.getHttpServer())
      .post("/admin/binders")
      .set(bearer(token))
      .send({ teamId: randomUUID(), name: "X" })
      .expect(404);
    expect(res.body.error.code).toBe("team_not_found");
  });

  it("returns 409 name_already_exists for a duplicate binder", async () => {
    const token = await userToken({ admin: true });
    const res = await request(app.getHttpServer())
      .post("/admin/binders")
      .set(bearer(token))
      .send({ teamId: TEAM_A, name: "Binder" })
      .expect(409);
    expect(res.body.error.code).toBe("name_already_exists");
  });

  it("returns 404 folder_not_found for a parent in another binder", async () => {
    const token = await userToken({ admin: true });
    const res = await request(app.getHttpServer())
      .post("/admin/folders")
      .set(bearer(token))
      .send({ binderId: BINDER_A, parentFolderId: INBOX_B, name: "X" })
      .expect(404);
    expect(res.body.error.code).toBe("folder_not_found");
  });

  it("returns 409 name_already_exists for a duplicate root folder", async () => {
    const token = await userToken({ admin: true });
    const res = await request(app.getHttpServer())
      .post("/admin/folders")
      .set(bearer(token))
      .send({ binderId: BINDER_A, name: "Inbox" })
      .expect(409);
    expect(res.body.error.code).toBe("name_already_exists");
  });

  it("rejects a non-admin user on admin endpoints", async () => {
    const token = await userToken({ teams: [TEAM_A] });
    const res = await request(app.getHttpServer())
      .post("/admin/teams")
      .set(bearer(token))
      .send({ name: "Nope" })
      .expect(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("serves GET /tree in under 1s at 50 teams x 10 binders x 20 folders", async () => {
    const perfTeamIds: string[] = [];
    for (let t = 0; t < 50; t++) {
      const team = await db.team.create({
        data: { name: `perf-team-${String(t).padStart(3, "0")}` },
      });
      perfTeamIds.push(team.id);
      for (let b = 0; b < 10; b++) {
        const binder = await db.binder.create({
          data: { teamId: team.id, name: `perf-binder-${b}` },
        });
        await db.folder.createMany({
          data: Array.from({ length: 20 }, (_, f) => ({
            binderId: binder.id,
            name: `perf-folder-${f}`,
          })),
        });
      }
    }
    try {
      const adminToken = await userToken({ admin: true });
      let start = performance.now();
      const adminRes = await request(app.getHttpServer())
        .get("/tree?all=true")
        .set(bearer(adminToken))
        .expect(200);
      expect(performance.now() - start).toBeLessThan(1000);
      expect(adminRes.body.teams.length).toBeGreaterThanOrEqual(50);

      const memberToken = await userToken({ teams: perfTeamIds });
      start = performance.now();
      const memberRes = await request(app.getHttpServer())
        .get("/tree")
        .set(bearer(memberToken))
        .expect(200);
      expect(performance.now() - start).toBeLessThan(1000);
      expect(memberRes.body.teams).toHaveLength(50);
    } finally {
      await cleanPerfRows();
    }
  }, 120000);
});
