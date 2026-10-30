import { session } from "../../auth/session";
import { createWorkerHasher } from "./checksum-client";
import { putWithProgress } from "./transfer";
import { createUploadManager } from "./upload-manager";

export const uploadManager = createUploadManager({
  authFetch: session.authFetch,
  hash: createWorkerHasher(),
  put: putWithProgress,
});
