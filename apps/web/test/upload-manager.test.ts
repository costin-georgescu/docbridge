import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Session } from "../src/auth/session";
import { ApiError } from "../src/lib/api";
import { Checksums } from "../src/features/uploads/checksum";
import { Hasher } from "../src/features/uploads/checksum-client";
import {
  putWithProgress,
  TransferError,
} from "../src/features/uploads/transfer";
import {
  createUploadManager,
  UploadManager,
  UploadPhase,
} from "../src/features/uploads/upload-manager";

const FILE_ID = "11111111-2222-4333-8444-555555555555";
const futureExpiry = () => new Date(Date.now() + 3600_000).toISOString();

type AuthFetchFn = (path: string, init?: RequestInit) => Promise<unknown>;
type PutFn = typeof putWithProgress;

function makeFile(name: string, size: number, type = ""): File {
  return new File([new Uint8Array(size)], name, { type });
}

interface Setup {
  manager: UploadManager;
  authFetch: jest.Mock<AuthFetchFn>;
  hash: jest.Mock<Hasher>;
  put: jest.Mock<PutFn>;
  posts: () => { path: string; body: Record<string, unknown> }[];
}

function setup(
  opts: {
    checksums?: Checksums;
    hashImpl?: Hasher;
    putImpl?: PutFn;
    authFetchImpl?: AuthFetchFn;
  } = {},
): Setup {
  let counter = 0;
  const checksums = opts.checksums ?? { checksumCrc32c: "AAAAAA==" };
  const authFetch = jest.fn<AuthFetchFn>(
    opts.authFetchImpl ??
      ((path, init) => {
        if (path === "/api/uploads" && init?.method === "POST") {
          return Promise.resolve({
            fileId: FILE_ID,
            mode: "single",
            url: "https://s3/put",
            headers: {},
            expiresAt: futureExpiry(),
          });
        }
        if (path.startsWith("/api/uploads?ids=")) {
          return Promise.resolve([]);
        }
        return Promise.resolve({});
      }),
  );
  const hash = jest.fn<Hasher>(
    opts.hashImpl ?? (() => Promise.resolve(checksums)),
  );
  const put = jest.fn<PutFn>(
    opts.putImpl ?? (() => Promise.resolve({ etag: '"etag"' })),
  );
  const sleep = jest.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
  const manager = createUploadManager({
    authFetch: authFetch as unknown as Session["authFetch"],
    hash,
    put,
    sleep,
    newId: () => `item-${counter++}`,
  });
  return {
    manager,
    authFetch,
    hash,
    put,
    posts: () =>
      authFetch.mock.calls
        .filter((c) => c[1]?.method === "POST")
        .map((c) => ({
          path: c[0],
          body: JSON.parse(String(c[1]!.body)) as Record<string, unknown>,
        })),
  };
}

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

async function waitFor(cond: () => boolean, rounds = 2000) {
  for (let i = 0; i < rounds && !cond(); i++) {
    await Promise.resolve();
  }
  expect(cond()).toBe(true);
}

const phases = (manager: UploadManager): UploadPhase[] =>
  manager.getState().map((item) => item.phase);

describe("upload manager", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("uploads a single file and marks it staged after polling", async () => {
    const { manager, posts } = setup({
      authFetchImpl: (path, init) => {
        if (path === "/api/uploads" && init?.method === "POST") {
          return Promise.resolve({
            fileId: FILE_ID,
            mode: "single",
            url: "https://s3/put",
            headers: {},
            expiresAt: futureExpiry(),
          });
        }
        if (path.startsWith("/api/uploads?ids=")) {
          expect(path).toBe(`/api/uploads?ids=${FILE_ID}`);
          return Promise.resolve([{ fileId: FILE_ID, status: "staged" }]);
        }
        return Promise.resolve({});
      },
    });
    manager.addFiles([makeFile("a.pdf", 100, "application/pdf")]);
    await waitFor(() => phases(manager).includes("processing"));
    expect(posts()[0]).toMatchObject({
      path: "/api/uploads",
      body: {
        fileName: "a.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        checksumCrc32c: "AAAAAA==",
      },
    });
    await jest.advanceTimersByTimeAsync(2000);
    await flush();
    expect(phases(manager)).toEqual(["staged"]);
    expect(manager.getState()[0].fileId).toBe(FILE_ID);
  });

  it("multipart: sends part checksums, caps parallel puts at 4, completes sorted", async () => {
    const partSize = 10;
    const size = 55; // 6 parts
    const parts = Array.from({ length: 6 }, (_, i) => ({
      partNumber: i + 1,
      url: `https://s3/part-${i + 1}`,
      headers: {},
    }));
    let inflight = 0;
    let maxInflight = 0;
    const { manager, posts } = setup({
      checksums: {
        checksumCrc32c: "AAAAAA==",
        partChecksumsCrc32c: parts.map(() => "AAAAAA=="),
      },
      authFetchImpl: (path, init) => {
        if (path === "/api/uploads" && init?.method === "POST") {
          return Promise.resolve({
            fileId: FILE_ID,
            mode: "multipart",
            uploadId: "mpu",
            partSizeBytes: partSize,
            parts,
            expiresAt: futureExpiry(),
          });
        }
        return Promise.resolve({});
      },
      putImpl: () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        return Promise.resolve({ etag: '"e"' }).then((v) => {
          inflight -= 1;
          return v;
        });
      },
    });
    manager.addFiles([makeFile("big.pdf", size, "application/pdf")]);
    await waitFor(() => phases(manager).includes("processing"));
    expect(maxInflight).toBe(4);
    expect(posts()[0].body.partChecksumsCrc32c).toHaveLength(6);
    const complete = posts().find((p) => p.path.endsWith("/complete"))!;
    const sentParts = complete.body.parts as { partNumber: number }[];
    expect(sentParts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("retries a failing part with backoff and still completes", async () => {
    const parts = [1, 2].map((n) => ({
      partNumber: n,
      url: `https://s3/part-${n}`,
      headers: {},
    }));
    const sleep = jest.fn<(ms: number) => Promise<void>>(() =>
      Promise.resolve(),
    );
    let attempts = 0;
    let counter = 0;
    const authFetch = jest.fn<AuthFetchFn>((path, init) => {
      if (path === "/api/uploads" && init?.method === "POST") {
        return Promise.resolve({
          fileId: FILE_ID,
          mode: "multipart",
          uploadId: "mpu",
          partSizeBytes: 10,
          parts,
          expiresAt: futureExpiry(),
        });
      }
      return Promise.resolve({});
    });
    const manager = createUploadManager({
      authFetch: authFetch as unknown as Session["authFetch"],
      hash: () =>
        Promise.resolve({
          checksumCrc32c: "AAAAAA==",
          partChecksumsCrc32c: ["AAAAAA==", "AAAAAA=="],
        }),
      put: (url) => {
        if (url.endsWith("part-1") && attempts++ < 2) {
          return Promise.reject(new TransferError(503, "SlowDown", "slow"));
        }
        return Promise.resolve({ etag: '"e"' });
      },
      sleep,
      newId: () => `item-${counter++}`,
    });
    manager.addFiles([makeFile("big.pdf", 15, "application/pdf")]);
    await waitFor(() => phases(manager).includes("processing"));
    expect(attempts).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("resumes an unexpired plan on retry without re-putting finished parts", async () => {
    const parts = [1, 2, 3].map((n) => ({
      partNumber: n,
      url: `https://s3/part-${n}`,
      headers: {},
    }));
    const { manager, authFetch, put } = setup({
      checksums: {
        checksumCrc32c: "AAAAAA==",
        partChecksumsCrc32c: ["AAAAAA==", "AAAAAA==", "AAAAAA=="],
      },
      authFetchImpl: (path, init) => {
        if (path === "/api/uploads" && init?.method === "POST") {
          return Promise.resolve({
            fileId: FILE_ID,
            mode: "multipart",
            uploadId: "mpu",
            partSizeBytes: 10,
            parts,
            expiresAt: futureExpiry(),
          });
        }
        return Promise.resolve({});
      },
      putImpl: (url) =>
        url.endsWith("part-3")
          ? Promise.reject(new TransferError(403, "AccessDenied", "denied"))
          : Promise.resolve({ etag: '"e"' }),
    });
    manager.addFiles([makeFile("big.pdf", 25, "application/pdf")]);
    await waitFor(() => phases(manager).includes("error"));
    const item = manager.getState()[0];
    expect(item.error?.retryable).toBe(true);
    const createsBefore = authFetch.mock.calls.filter(
      (c) => c[0] === "/api/uploads",
    ).length;
    const putsBefore = put.mock.calls.length;

    put.mockImplementation(() => Promise.resolve({ etag: '"e"' }));
    manager.retry(item.id);
    await waitFor(() => phases(manager).includes("processing"));
    expect(
      authFetch.mock.calls.filter((c) => c[0] === "/api/uploads").length,
    ).toBe(createsBefore);
    expect(put.mock.calls.slice(putsBefore)).toHaveLength(1);
    expect(put.mock.calls[putsBefore][0].endsWith("part-3")).toBe(true);
  });

  it("requests a fresh upload on retry when the plan expired", async () => {
    const { manager, posts, put } = setup({
      authFetchImpl: (path, init) => {
        if (path === "/api/uploads" && init?.method === "POST") {
          return Promise.resolve({
            fileId: FILE_ID,
            mode: "single",
            url: "https://s3/put",
            headers: {},
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          });
        }
        return Promise.resolve({});
      },
      putImpl: () =>
        Promise.reject(new TransferError(403, "AccessDenied", "denied")),
    });
    manager.addFiles([makeFile("a.pdf", 100, "application/pdf")]);
    await waitFor(() => phases(manager).includes("error"));
    const creates = () => posts().filter((p) => p.path === "/api/uploads");
    expect(creates()).toHaveLength(1);

    put.mockImplementation(() => Promise.resolve({ etag: '"e"' }));
    manager.retry(manager.getState()[0].id);
    await waitFor(() => phases(manager).includes("processing"));
    expect(creates()).toHaveLength(2);
  });

  it("surfaces a checksum mismatch from the API and rehashes on retry", async () => {
    const parts = [1, 2].map((n) => ({
      partNumber: n,
      url: `https://s3/part-${n}`,
      headers: {},
    }));
    const { manager, hash, posts } = setup({
      checksums: {
        checksumCrc32c: "AAAAAA==",
        partChecksumsCrc32c: ["AAAAAA==", "AAAAAA=="],
      },
      authFetchImpl: (path, init) => {
        if (path === "/api/uploads" && init?.method === "POST") {
          return Promise.resolve({
            fileId: FILE_ID,
            mode: "multipart",
            uploadId: "mpu",
            partSizeBytes: 10,
            parts,
            expiresAt: futureExpiry(),
          });
        }
        if (path.endsWith("/complete")) {
          return Promise.reject(
            new ApiError(400, "checksum_mismatch", "bad digest"),
          );
        }
        return Promise.resolve({});
      },
    });
    manager.addFiles([makeFile("big.pdf", 15, "application/pdf")]);
    await waitFor(() => phases(manager).includes("error"));
    expect(manager.getState()[0].error?.code).toBe("checksum_mismatch");
    expect(hash).toHaveBeenCalledTimes(1);
    expect(posts().filter((p) => p.path === "/api/uploads")).toHaveLength(1);

    hash.mockClear();
    manager.retry(manager.getState()[0].id);
    await waitFor(() => phases(manager).includes("error"));
    expect(hash).toHaveBeenCalledTimes(1);
    expect(posts().filter((p) => p.path === "/api/uploads")).toHaveLength(2);
  });

  it("flags client-side validation errors without uploading", async () => {
    const { manager, hash, authFetch } = setup();
    const oversized = {
      name: "huge.pdf",
      size: 1024 ** 3 + 1,
      type: "application/pdf",
      slice: () => new Blob(),
    } as unknown as File;
    manager.addFiles([
      makeFile("notes.txt", 10),
      makeFile("a.pdf", 10, "text/plain"),
      makeFile("empty.pdf", 0, "application/pdf"),
      oversized,
    ]);
    const items = manager.getState();
    expect(items.map((i) => i.phase)).toEqual([
      "error",
      "error",
      "error",
      "error",
    ]);
    expect(items[0].error?.code).toBe("unsupported_file_type");
    expect(items[1].error?.code).toBe("unsupported_file_type");
    expect(items[2].error?.code).toBe("validation_error");
    expect(items[3].error?.code).toBe("file_too_large");
    expect(items.every((i) => i.error?.retryable === false)).toBe(true);
    await flush();
    expect(hash).not.toHaveBeenCalled();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("remove() aborts an in-flight upload and the item does not reappear", async () => {
    let resolvePut: (v: { etag: string | null }) => void = () => {};
    const { manager } = setup({
      putImpl: () =>
        new Promise((resolve) => {
          resolvePut = resolve;
        }),
    });
    manager.addFiles([makeFile("a.pdf", 100, "application/pdf")]);
    await waitFor(() => phases(manager).includes("uploading"));
    manager.remove(manager.getState()[0].id);
    expect(manager.getState()).toHaveLength(0);
    resolvePut({ etag: '"e"' });
    await flush();
    expect(manager.getState()).toHaveLength(0);
  });

  it("polls in chunks of at most 100 ids and stops when all are staged", async () => {
    const chunkSizes: number[] = [];
    let fileCounter = 0;
    const { manager } = setup({
      authFetchImpl: (path, init) => {
        if (path === "/api/uploads" && init?.method === "POST") {
          const fileId = `file-${fileCounter++}`;
          return Promise.resolve({
            fileId,
            mode: "single",
            url: "https://s3/put",
            headers: {},
            expiresAt: futureExpiry(),
          });
        }
        if (path.startsWith("/api/uploads?ids=")) {
          const ids = path.split("ids=")[1].split(",");
          chunkSizes.push(ids.length);
          return Promise.resolve(
            ids.map((fileId) => ({ fileId, status: "staged" })),
          );
        }
        return Promise.resolve({});
      },
    });
    const files = Array.from({ length: 101 }, (_, i) =>
      makeFile(`f${i}.pdf`, 10, "application/pdf"),
    );
    manager.addFiles(files);
    await waitFor(
      () =>
        manager.getState().filter((i) => i.phase === "processing").length ===
        101,
      20000,
    );
    await jest.advanceTimersByTimeAsync(2000);
    await waitFor(
      () => manager.getState().every((i) => i.phase === "staged"),
      20000,
    );
    expect(chunkSizes).toEqual([100, 1]);
    const callsAfterStaged = chunkSizes.length;
    await jest.advanceTimersByTimeAsync(4000);
    await flush();
    expect(chunkSizes.length).toBe(callsAfterStaged);
  });

  it("keeps at most 3 files active at once", async () => {
    const { manager } = setup({
      hashImpl: () => new Promise<Checksums>(() => {}),
    });
    manager.addFiles(
      Array.from({ length: 5 }, (_, i) =>
        makeFile(`f${i}.pdf`, 10, "application/pdf"),
      ),
    );
    await flush();
    const ps = phases(manager);
    expect(
      ps.filter((p) => ["hashing", "uploading", "completing"].includes(p)),
    ).toHaveLength(3);
    expect(ps.filter((p) => p === "queued")).toHaveLength(2);
  });
});
