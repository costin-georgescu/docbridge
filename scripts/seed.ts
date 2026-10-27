import { createClient as createAuthClient } from "@docbridge/db-auth";
import { createClient as createPlatformClient } from "@docbridge/db-platform";
import argon2 from "argon2";

const authUrl = process.env.AUTH_DATABASE_URL;
const platformUrl = process.env.PLATFORM_DATABASE_URL;
if (!authUrl || !platformUrl) {
  throw new Error("AUTH_DATABASE_URL and PLATFORM_DATABASE_URL must be set");
}

const TEAM_A = "00000000-0000-7000-8000-0000000000a1";
const TEAM_B = "00000000-0000-7000-8000-0000000000b1";
const TEAM_C = "00000000-0000-7000-8000-0000000000c1";

const TEAMS = [
  { id: TEAM_A, name: "Oncology Site A" },
  { id: TEAM_B, name: "Cardiology Site B" },
  { id: TEAM_C, name: "Central Regulatory" },
];

async function seedPlatform() {
  const db = createPlatformClient(platformUrl!);
  for (const team of TEAMS) {
    await db.team.upsert({
      where: { id: team.id },
      update: { name: team.name },
      create: team,
    });
    for (const binderName of ["Binder 1", "Binder 2"]) {
      const binder = await db.binder.upsert({
        where: { teamId_name: { teamId: team.id, name: binderName } },
        update: {},
        create: { teamId: team.id, name: binderName },
      });
      async function ensureFolder(name: string, parentFolderId: string | null) {
        // upsert's compound-unique where rejects null parts, so find+create.
        const existing = await db.folder.findFirst({
          where: { binderId: binder.id, name, parentFolderId },
        });
        if (existing) return existing;
        return db.folder.create({
          data: { binderId: binder.id, name, parentFolderId },
        });
      }
      const inbox = await ensureFolder("Inbox", null);
      await ensureFolder("Archive", inbox.id);
      await ensureFolder("Reports", null);
    }
  }
  return db.$disconnect();
}

async function seedAuth() {
  const db = createAuthClient(authUrl!);
  const passwordHash = await argon2.hash("password123");
  const users = [
    {
      email: "admin@docbridge.local",
      displayName: "Admin",
      isAdmin: true,
      teamIds: [TEAM_A, TEAM_B, TEAM_C],
    },
    {
      email: "anna@docbridge.local",
      displayName: "Anna",
      isAdmin: false,
      teamIds: [TEAM_A, TEAM_C],
    },
    {
      email: "ben@docbridge.local",
      displayName: "Ben",
      isAdmin: false,
      teamIds: [TEAM_B],
    },
  ];
  for (const u of users) {
    const user = await db.user.upsert({
      where: { email: u.email },
      update: { displayName: u.displayName, isAdmin: u.isAdmin },
      create: {
        email: u.email,
        passwordHash,
        displayName: u.displayName,
        isAdmin: u.isAdmin,
      },
    });
    for (const teamId of u.teamIds) {
      await db.teamMembership.upsert({
        where: { userId_teamId: { userId: user.id, teamId } },
        update: {},
        create: { userId: user.id, teamId },
      });
    }
  }
  // Worker service client; the real secret lives in Secrets Manager,
  // locally it is WORKER_CLIENT_SECRET=local-worker-secret in .env.
  const workerSecret = process.env.WORKER_CLIENT_SECRET;
  if (!workerSecret) throw new Error("WORKER_CLIENT_SECRET must be set");
  await db.serviceClient.upsert({
    where: { id: "worker" },
    update: {
      secretHash: await argon2.hash(workerSecret),
      scopes: ["documents:write"],
    },
    create: {
      id: "worker",
      secretHash: await argon2.hash(workerSecret),
      scopes: ["documents:write"],
    },
  });
  return db.$disconnect();
}

async function main() {
  await seedPlatform();
  await seedAuth();

  const platformDb = createPlatformClient(platformUrl!);
  const authDb = createAuthClient(authUrl!);
  const [teams, binders, folders, userCount, memberships, clients] =
    await Promise.all([
      platformDb.team.count(),
      platformDb.binder.count(),
      platformDb.folder.count(),
      authDb.user.count(),
      authDb.teamMembership.count(),
      authDb.serviceClient.count(),
    ]);
  console.log(
    `seed done: teams=${teams} binders=${binders} folders=${folders} users=${userCount} memberships=${memberships} serviceClients=${clients}`,
  );
  await platformDb.$disconnect();
  await authDb.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
