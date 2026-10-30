import { useSyncExternalStore } from "react";
import { uploadManager } from "./instance";
import { UploadItem } from "./upload-manager";

export function useUploads(): UploadItem[] {
  return useSyncExternalStore(uploadManager.subscribe, uploadManager.getState);
}
