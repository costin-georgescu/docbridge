import fs from "node:fs";
import path from "node:path";

// Generated upload fixtures (the 100 MiB multipart file among them) are
// per-run — drop them so repeated runs don't accumulate on disk.
// test-results/ is kept on purpose: it holds traces and screenshots needed
// to debug failures.
export default async function globalTeardown() {
  fs.rmSync(path.join(__dirname, ".fixtures"), {
    recursive: true,
    force: true,
  });
}
