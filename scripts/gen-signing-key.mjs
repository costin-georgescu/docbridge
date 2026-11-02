import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Thin wrapper: the real implementation is gen-signing-key.ts so the pure
// parts stay unit-testable under ts-jest.
const script = fileURLToPath(
  new URL("./gen-signing-key.impl.ts", import.meta.url),
);
const result = spawnSync(
  "node",
  ["--import", "tsx", script, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
