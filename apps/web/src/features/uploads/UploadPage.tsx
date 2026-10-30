import { FileDropzone } from "./FileDropzone";
import { uploadManager } from "./instance";
import { UploadList } from "./UploadList";
import { useUploads } from "./useUploads";

export function UploadPage() {
  const items = useUploads();
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-gray-900">Upload files</h1>
      <FileDropzone onFiles={(files) => uploadManager.addFiles(files)} />
      <UploadList
        items={items}
        onRetry={(id) => uploadManager.retry(id)}
        onRemove={(id) => uploadManager.remove(id)}
      />
    </div>
  );
}
