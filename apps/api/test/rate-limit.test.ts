import { describe, expect, it, jest } from "@jest/globals";
import { RateLimiterRegistry } from "@docbridge/rate-limit";
import { AppError } from "../src/common/app-error";
import { config } from "../src/config";
import { JobsController } from "../src/jobs/jobs.controller";
import { UploadsController } from "../src/uploads/uploads.controller";
import type { JobsService } from "../src/jobs/jobs.service";
import type { UploadsService } from "../src/uploads/uploads.service";

const claims = { sub: "user-1", teams: [] } as never;
const req = {
  headers: { authorization: "Bearer token" },
} as never;

const codeOf = (e: unknown): string | undefined =>
  e instanceof AppError
    ? (e.getResponse() as { error?: { code?: string } }).error?.code
    : undefined;

function throwsWithCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(codeOf(e)).toBe(code);
    return;
  }
  throw new Error(`expected AppError ${code}`);
}

const restore = <K extends keyof typeof config>(key: K) => {
  const original = config[key];
  return () => {
    (config as Record<K, unknown>)[key] = original;
  };
};

describe("api rate limits", () => {
  it("POST /api/jobs returns 429 past RATE_LIMIT_JOBS_PER_MIN", () => {
    const undo = restore("RATE_LIMIT_JOBS_PER_MIN");
    try {
      config.RATE_LIMIT_JOBS_PER_MIN = 2;
      const createJob = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({ jobId: "j" });
      const controller = new JobsController(
        { createJob } as unknown as JobsService,
        new RateLimiterRegistry(),
      );
      controller.createJob(claims, req, {} as never);
      controller.createJob(claims, req, {} as never);
      throwsWithCode(
        () => controller.createJob(claims, req, {} as never),
        "too_many_requests",
      );
      expect(createJob).toHaveBeenCalledTimes(2);
    } finally {
      undo();
    }
  });

  it("POST /api/uploads* shares one per-user budget across create and complete", () => {
    const undo = restore("RATE_LIMIT_UPLOADS_PER_MIN");
    try {
      config.RATE_LIMIT_UPLOADS_PER_MIN = 1;
      const createUpload = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({});
      const completeUpload = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({});
      const controller = new UploadsController(
        { createUpload, completeUpload } as unknown as UploadsService,
        new RateLimiterRegistry(),
      );
      controller.createUpload(claims, {} as never);
      throwsWithCode(
        () => controller.createUpload(claims, {} as never),
        "too_many_requests",
      );
      // Same bucket: complete hits the exhausted budget too.
      throwsWithCode(
        () => controller.completeUpload(claims, "f", {} as never),
        "too_many_requests",
      );
      // A different user still has budget.
      const other = { sub: "user-2", teams: [] } as never;
      controller.completeUpload(other, "f", {} as never);
      expect(createUpload).toHaveBeenCalledTimes(1);
      expect(completeUpload).toHaveBeenCalledTimes(1);
    } finally {
      undo();
    }
  });
});
