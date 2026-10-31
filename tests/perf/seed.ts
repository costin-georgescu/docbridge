// Perf fixture seed for TDD 5.3 (k6). Deviation note: staged_files rows are
// seeded directly in the database — going through the real upload pipeline
// for ~200k files is impractical, and POST /api/jobs only reads row state.
//
// Usage:
//   node --env-file=.env --import tsx tests/perf/seed.ts           seed + write manifest
//   node --env-file=.env --import tsx tests/perf/seed.ts --cleanup remove perf data
//
// Writes tests/perf/manifest.json (small) and tests/perf/chunks.txt
// (one comma-separated line of 100 staged file ids per job iteration).

import { createClient as createAuthClient } from "@docbridge/db-auth";
import { createClient as createDocbridgeClient } from "@docbridge/db-docbridge";
import { Prisma } from "@docbridge/db-docbridge";
import { createClient as createPlatformClient } from "@docbridge/db-platform";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const authUrl = process.env.AUTH_DATABASE_URL;
const docbridgeUrl = process.env.DOCBRIDGE_DATABASE_URL;
const platformUrl = process.env.PLATFORM_DATABASE_URL;
if (!authUrl || !docbridgeUrl || !platformUrl) {
  throw new Error(
    "AUTH_DATABASE_URL, DOCBRIDGE_DATABASE_URL and PLATFORM_DATABASE_URL must be set",
  );
}

const TEAM_COUNT = 50; // TDD: "GET /tree at 50 teams"
const BINDERS_PER_TEAM = 3;
const TOP_FOLDERS_PER_BINDER = 8;
const CHILD_FOLDERS = 2; // nested under the first top-level folder
const JOB_ITERATIONS = 2000; // shared-iterations count for the k6 jobs run
const FILES_PER_JOB = 100; // TDD: "100 files"
const JOB_FOLDER_COUNT = 20; // TDD: "x 20 folders"
// Keep a multiple of FILES_PER_JOB so every seeded chunk has exactly
// FILES_PER_JOB ids (k6 submits one chunk per iteration).
const INSERT_BATCH = 20 * FILES_PER_JOB;

const PERF_USER_ID = "00000000-0000-7000-8000-0000000000f1";
const PERF_EMAIL = "perf@docbridge.local";
const PERF_PASSWORD = "perf-local-password";

const teamId = (n: number): string =>
  `00000000-0000-7000-8000-00000000f${String(n).padStart(3, "0")}`;
const TEAM_IDS = Array.from({ length: TEAM_COUNT }, (_, i) => teamId(i + 1));

const manifestPath = fileURLToPath(new URL("./manifest.json", import.meta.url));
const chunksPath = fileURLToPath(new URL("./chunks.txt", import.meta.url));

function uuidList(ids: string[]) {
  return Prisma.Prisma.join(ids.map((id) => Prisma.Prisma.sql`${id}::uuid`));
}

async function cleanupDocbridge() {
  const db = createDocbridgeClient(docbridgeUrl!);
  try {
    const jobIds = Prisma.Prisma.sql`SELECT id FROM jobs WHERE submitter_user_id = ${PERF_USER_ID}::uuid`;
    await db.$executeRaw`DELETE FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE job_id IN (${jobIds}))`;
    await db.$executeRaw`DELETE FROM tasks WHERE job_id IN (${jobIds})`;
    await db.$executeRaw`DELETE FROM staged_files WHERE owner_user_id = ${PERF_USER_ID}::uuid`;
    await db.$executeRaw`DELETE FROM job_teams WHERE job_id IN (${jobIds})`;
    await db.$executeRaw`DELETE FROM jobs WHERE submitter_user_id = ${PERF_USER_ID}::uuid`;
  } finally {
    await db.$disconnect();
  }
}

async function cleanupPlatform() {
  const db = createPlatformClient(platformUrl!);
  try {
    const teams = uuidList(TEAM_IDS);
    const binders = Prisma.Prisma.sql`SELECT id FROM binders WHERE team_id IN (${teams})`;
    const folders = Prisma.Prisma.sql`SELECT id FROM folders WHERE binder_id IN (${binders})`;
    await db.$executeRaw`DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE folder_id IN (${folders}))`;
    await db.$executeRaw`DELETE FROM documents WHERE folder_id IN (${folders})`;
    await db.$executeRaw`DELETE FROM folders WHERE binder_id IN (${binders})`;
    await db.$executeRaw`DELETE FROM binders WHERE team_id IN (${teams})`;
    await db.$executeRaw`DELETE FROM teams WHERE id IN (${teams})`;
  } finally {
    await db.$disconnect();
  }
}

async function cleanupAuth() {
  const db = createAuthClient(authUrl!);
  try {
    await db.$executeRaw`DELETE FROM team_memberships WHERE user_id = ${PERF_USER_ID}::uuid`;
    await db.$executeRaw`DELETE FROM refresh_tokens WHERE user_id = ${PERF_USER_ID}::uuid`;
    await db.$executeRaw`DELETE FROM users WHERE id = ${PERF_USER_ID}::uuid`;
  } finally {
    await db.$disconnect();
  }
}

// The three databases are independent, so clean them concurrently and
// aggregate failures — one failing DB shouldn't leave the others dirty.
async function cleanup() {
  const results = await Promise.allSettled([
    cleanupDocbridge(),
    cleanupPlatform(),
    cleanupAuth(),
  ]);
  await rm(manifestPath, { force: true });
  await rm(chunksPath, { force: true });
  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.reason),
      "perf cleanup failed",
    );
  }
}

async function seedPlatform(): Promise<string[]> {
  const db = createPlatformClient(platformUrl!);
  await db.team.createMany({
    data: TEAM_IDS.map((id, i) => ({ id, name: `Perf Team ${i + 1}` })),
  });

  // One nested child per binder doubles as the delivery destination, so
  // resolveFolders exercises path building across 20 distinct binders.
  const binders: { id: string; teamIndex: number; name: string }[] = [];
  for (let t = 0; t < TEAM_COUNT; t++) {
    for (let b = 0; b < BINDERS_PER_TEAM; b++) {
      binders.push({ id: randomUUID(), teamIndex: t, name: `Binder ${b + 1}` });
    }
  }
  await db.binder.createMany({
    data: binders.map((b) => ({ id: b.id, teamId: TEAM_IDS[b.teamIndex], name: b.name })),
  });

  const folders: {
    id: string;
    binderId: string;
    parentFolderId: string | null;
    name: string;
  }[] = [];
  const destinationFolderIds: string[] = [];
  for (const binder of binders) {
    let parentId: string | null = null;
    for (let f = 0; f < TOP_FOLDERS_PER_BINDER; f++) {
      const id = randomUUID();
      folders.push({ id, binderId: binder.id, parentFolderId: null, name: `Folder ${f + 1}` });
      if (f === 0) parentId = id;
    }
    for (let c = 0; c < CHILD_FOLDERS; c++) {
      const id = randomUUID();
      folders.push({
        id,
        binderId: binder.id,
        parentFolderId: parentId,
        name: `Archive ${c + 1}`,
      });
      // The job destination: "Archive 1" of binder 1 in each of the first
      // JOB_FOLDER_COUNT teams.
      if (
        c === 0 &&
        binder.name === "Binder 1" &&
        binder.teamIndex < JOB_FOLDER_COUNT
      ) {
        destinationFolderIds.push(id);
      }
    }
  }
  await db.folder.createMany({ data: folders });
  await db.$disconnect();
  return destinationFolderIds;
}

async function seedAuth() {
  const db = createAuthClient(authUrl!);
  const passwordHash = await argon2.hash(PERF_PASSWORD);
  await db.user.create({
    data: {
      id: PERF_USER_ID,
      email: PERF_EMAIL,
      passwordHash,
      displayName: "Perf User",
      isAdmin: false,
    },
  });
  await db.teamMembership.createMany({
    data: TEAM_IDS.map((teamId) => ({ userId: PERF_USER_ID, teamId })),
  });
  await db.$disconnect();
}

async function seedStagedFiles(): Promise<string[][]> {
  const db = createDocbridgeClient(docbridgeUrl!);
  const chunks: string[][] = [];
  const total = JOB_ITERATIONS * FILES_PER_JOB;
  for (let base = 0; base < total; base += INSERT_BATCH) {
    const rows: Prisma.Prisma.StagedFileCreateManyInput[] = [];
    for (let i = base; i < Math.min(base + INSERT_BATCH, total); i++) {
      const id = randomUUID();
      rows.push({
        id,
        ownerUserId: PERF_USER_ID,
        fileName: `perf-${i}.pdf`,
        contentType: "application/pdf",
        sizeBytes: 4096,
        checksumCrc32c: "AAAAAA==",
        storageKey: `staged/${PERF_USER_ID}/${id}`,
        status: "staged" as const,
        stagedAt: new Date(),
      });
      chunks[Math.floor(i / FILES_PER_JOB)] ??= [];
      chunks[Math.floor(i / FILES_PER_JOB)].push(id);
    }
    await db.stagedFile.createMany({ data: rows });
    process.stdout.write(`\rstaged_files: ${Math.min(base + INSERT_BATCH, total)}/${total}`);
  }
  process.stdout.write("\n");
  await db.$disconnect();
  return chunks;
}

async function main() {
  await cleanup();
  if (process.argv.includes("--cleanup")) {
    console.log("perf fixtures removed");
    return;
  }
  const folderIds = await seedPlatform();
  await seedAuth();
  const fileChunks = await seedStagedFiles();

  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        email: PERF_EMAIL,
        password: PERF_PASSWORD,
        folderIds,
        iterations: fileChunks.length,
      },
      null,
      2,
    ),
  );
  await writeFile(
    chunksPath,
    fileChunks.map((chunk) => chunk.join(",")).join("\n") + "\n",
  );
  console.log(
    `perf seed done: teams=${TEAM_COUNT} folders=${TEAM_COUNT * BINDERS_PER_TEAM * (TOP_FOLDERS_PER_BINDER + CHILD_FOLDERS)} ` +
      `stagedFiles=${JOB_ITERATIONS * FILES_PER_JOB} chunks=${fileChunks.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
