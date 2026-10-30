import { describe, expect, it } from "@jest/globals";
import { fileIdFromStagedKey, TaskMessage, UploadEventMessage } from "../src";

const OWNER = "11111111-2222-3333-4444-555555555555";
const FILE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("fileIdFromStagedKey", () => {
  it("parses a staged key", () => {
    expect(fileIdFromStagedKey(`staged/${OWNER}/${FILE}`)).toEqual({
      ownerUserId: OWNER,
      fileId: FILE,
    });
  });

  it("decodes URL-encoded keys", () => {
    expect(fileIdFromStagedKey(`staged/${OWNER}/${FILE}%20?`)).toBeNull(); // extra decoded chars still fail the shape
    expect(
      fileIdFromStagedKey(`staged/${OWNER}/${FILE}`.replace(/-/g, "%2D")),
    ).toEqual({ ownerUserId: OWNER, fileId: FILE });
  });

  it("rejects a wrong prefix", () => {
    expect(fileIdFromStagedKey(`other/${OWNER}/${FILE}`)).toBeNull();
  });

  it("rejects non-uuid segments", () => {
    expect(fileIdFromStagedKey(`staged/${OWNER}/not-a-uuid`)).toBeNull();
  });

  it("rejects extra segments", () => {
    expect(fileIdFromStagedKey(`staged/${OWNER}/${FILE}/extra`)).toBeNull();
    expect(fileIdFromStagedKey(`x/staged/${OWNER}/${FILE}`)).toBeNull();
  });
});

describe("UploadEventMessage", () => {
  it("parses an S3 Records event", () => {
    const parsed = UploadEventMessage.safeParse({
      Records: [
        {
          eventName: "s3:ObjectCreated:Put",
          s3: {
            bucket: { name: "docbridge-staging" },
            object: { key: `staged/${OWNER}/${FILE}` },
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("parses the S3 test event", () => {
    const parsed = UploadEventMessage.safeParse({
      Event: "s3:TestEvent",
      Service: "Amazon S3",
      Bucket: "docbridge-staging",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects garbage", () => {
    expect(UploadEventMessage.safeParse("hello").success).toBe(false);
    expect(UploadEventMessage.safeParse({}).success).toBe(false);
    expect(
      UploadEventMessage.safeParse({ Records: [{ foo: 1 }] }).success,
    ).toBe(false);
  });
});

describe("TaskMessage", () => {
  const TASK = "11111111-1111-4111-8111-111111111111";
  const JOB = "22222222-2222-4222-8222-222222222222";

  it("parses a task message", () => {
    const parsed = TaskMessage.safeParse({ v: 1, taskId: TASK, jobId: JOB });
    expect(parsed.success).toBe(true);
  });

  it("rejects wrong versions and non-uuids", () => {
    expect(
      TaskMessage.safeParse({ v: 2, taskId: TASK, jobId: JOB }).success,
    ).toBe(false);
    expect(
      TaskMessage.safeParse({ v: 1, taskId: "nope", jobId: JOB }).success,
    ).toBe(false);
    expect(TaskMessage.safeParse({ taskId: TASK, jobId: JOB }).success).toBe(
      false,
    );
  });
});
