import fs from "node:fs";
import path from "node:path";

// Playwright transpiles this package to CJS (no "type": "module"), so
// __dirname is the package directory.
const FIXTURE_DIR = path.join(__dirname, ".fixtures");

// Unique per worker process so file names identify this run in the UI and in
// the job list.
export const runId = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 7)}`;

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const SMALL_PDF = Buffer.from(
  "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
);

// Above the 64 MiB multipart threshold → 7 parts at 16 MiB. Only the magic
// bytes need to be a real PDF; the worker checks the signature, not the body.
const BIG_PDF_BYTES = 100 * 1024 ** 2;

const created = new Map<string, string>();

export function fixture(kind: "pdf" | "png" | "big-pdf"): string {
  const hit = created.get(kind);
  if (hit) return hit;
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  let file: string;
  if (kind === "big-pdf") {
    const body = Buffer.alloc(BIG_PDF_BYTES);
    SMALL_PDF.copy(body, 0);
    file = path.join(FIXTURE_DIR, `e2e-${runId}-large.pdf`);
    fs.writeFileSync(file, body);
  } else {
    const ext = kind === "pdf" ? "pdf" : "png";
    const body = kind === "pdf" ? SMALL_PDF : PNG_1PX;
    file = path.join(FIXTURE_DIR, `e2e-${runId}-doc.${ext}`);
    fs.writeFileSync(file, body);
  }
  created.set(kind, file);
  return file;
}
