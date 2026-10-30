import { describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  PlatformDeliveryClient,
  DeliverRequest,
} from "../src/platform/platform-client";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const errorBody = (code: string, message: string) => ({
  error: { code, message, details: {} },
});

function request(overrides: Partial<DeliverRequest> = {}): DeliverRequest {
  return {
    token: "service-token",
    taskId: randomUUID(),
    submitterUserId: randomUUID(),
    folderId: randomUUID(),
    fileName: "report final.pdf",
    contentType: "application/pdf",
    sizeBytes: 11n,
    checksumCrc32c: "AAAAAA==",
    body: Readable.from([Buffer.from("%PDF-1.4 x")]),
    ...overrides,
  };
}

function clientWith(
  fetchImpl: typeof fetch,
  deadlineMs = 60_000,
): { client: PlatformDeliveryClient } {
  return {
    client: new PlatformDeliveryClient({
      baseUrl: "http://platform:3002/",
      fetch: fetchImpl,
      deadlineMs,
    }),
  };
}

describe("PlatformDeliveryClient", () => {
  it("delivers with the contract headers and a streamed body", async () => {
    const documentId = randomUUID();
    const calls: { url: string; init: RequestInit }[] = [];
    const stub: typeof fetch = async (url, init) => {
      calls.push({ url: url as string, init: init as RequestInit });
      // drain the body like a real server
      for await (const chunk of init?.body as Readable) void chunk;
      return json(201, { documentId, versionNo: 1 });
    };
    const { client } = clientWith(stub);
    const req = request();
    const outcome = await client.deliver(req);

    expect(outcome).toEqual({
      kind: "delivered",
      documentId,
      versionNo: 1,
    });
    const { url, init } = calls[0];
    expect(url).toBe(`http://platform:3002/folders/${req.folderId}/documents`);
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer service-token");
    expect(headers["x-delivery-task-id"]).toBe(req.taskId);
    expect(headers["x-submitter-user-id"]).toBe(req.submitterUserId);
    expect(headers["x-file-name"]).toBe(encodeURIComponent(req.fileName));
    expect(headers["x-checksum-crc32c"]).toBe("AAAAAA==");
    expect(headers["content-type"]).toBe("application/pdf");
    expect(headers["content-length"]).toBe("11");
  });

  it("treats 200 alreadyDelivered as delivered", async () => {
    const documentId = randomUUID();
    const stub: typeof fetch = async (url, init) => {
      for await (const chunk of init?.body as Readable) void chunk;
      return json(200, { documentId, versionNo: 3, alreadyDelivered: true });
    };
    const { client } = clientWith(stub);
    expect(await client.deliver(request())).toEqual({
      kind: "delivered",
      documentId,
      versionNo: 3,
    });
  });

  it("maps 400 checksum_mismatch to a permanent checksum_mismatch", async () => {
    const stub: typeof fetch = async () =>
      json(400, errorBody("checksum_mismatch", "crc does not match"));
    const { client } = clientWith(stub);
    expect(await client.deliver(request())).toEqual({
      kind: "permanent",
      code: "checksum_mismatch",
      message: "crc does not match",
    });
  });

  it("maps 404 to a permanent folder_not_found", async () => {
    const stub: typeof fetch = async () =>
      json(404, errorBody("folder_not_found", "no such folder"));
    const { client } = clientWith(stub);
    expect(await client.deliver(request())).toEqual({
      kind: "permanent",
      code: "folder_not_found",
      message: "no such folder",
    });
  });

  it.each([403, 413, 415, 422])(
    "maps %i and other 4xx to a permanent platform_rejected",
    async (status) => {
      const stub: typeof fetch = async () =>
        json(status, errorBody("forbidden", "nope"));
      const { client } = clientWith(stub);
      const outcome = await client.deliver(request());
      expect(outcome).toEqual({
        kind: "permanent",
        code: "platform_rejected",
        message: "nope",
      });
    },
  );

  it.each([429, 500, 502, 503])(
    "maps %i to a retryable platform_unavailable",
    async (status) => {
      const stub: typeof fetch = async () =>
        json(status, errorBody("internal_error", "boom"));
      const { client } = clientWith(stub);
      const outcome = await client.deliver(request());
      expect(outcome).toEqual({
        kind: "retryable",
        code: "platform_unavailable",
        message: "boom",
      });
    },
  );

  it("maps a transport error to a retryable platform_unavailable", async () => {
    const stub: typeof fetch = async () => {
      throw new TypeError("connect ECONNREFUSED");
    };
    const { client } = clientWith(stub);
    const outcome = await client.deliver(request());
    expect(outcome).toMatchObject({
      kind: "retryable",
      code: "platform_unavailable",
    });
  });

  it("maps the deadline to a retryable delivery_timeout", async () => {
    const stub: typeof fetch = async () => {
      const err = new Error("The operation timed out");
      err.name = "TimeoutError";
      throw err;
    };
    const { client } = clientWith(stub);
    const outcome = await client.deliver(request());
    expect(outcome).toMatchObject({
      kind: "retryable",
      code: "delivery_timeout",
    });
  });

  it("maps a malformed success body to retryable platform_unavailable", async () => {
    const stub: typeof fetch = async (url, init) => {
      for await (const chunk of init?.body as Readable) void chunk;
      return json(201, { unexpected: true });
    };
    const { client } = clientWith(stub);
    const outcome = await client.deliver(request());
    expect(outcome).toMatchObject({
      kind: "retryable",
      code: "platform_unavailable",
    });
  });
});
