import { DragEvent, useRef, useState } from "react";
import { Button } from "../../components/Button";

const ACCEPT = ".pdf,.docx,.xlsx,.png,.jpg,.jpeg";

export function FileDropzone({
  onFiles,
  compact = false,
  className = "",
}: {
  onFiles: (files: File[]) => void;
  compact?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    onFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 text-center ${
        compact ? "py-4" : "py-10"
      } ${
        dragging ? "border-accent bg-accent-soft" : "border-line bg-ink/[0.02]"
      } ${className}`}
    >
      <p className="text-sm text-muted">
        {compact
          ? "Drop files here to add more."
          : "Drag and drop files here, or browse to select them."}
      </p>
      {!compact && (
        <p className="text-xs text-muted">
          PDF, DOCX, XLSX, PNG, or JPG up to 1 GiB.
        </p>
      )}
      <Button variant="secondary" onClick={() => inputRef.current?.click()}>
        {compact ? "+ Add files" : "Browse"}
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        data-testid="file-input"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
    </div>
  );
}
