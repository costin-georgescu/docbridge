import path from "node:path";
import { expect, test } from "@playwright/test";
import { fixture } from "../fixtures";
import {
  folderCheckbox,
  folderPath,
  login,
  SEED_USERS,
  sha256File,
  submitComposedJob,
  waitJobCompleted,
  waitStaged,
} from "./helpers";

// Step 5.2 fixture: a 100 MiB file crosses the 64 MiB threshold and goes
// through the multipart path — 7 parts at 16 MiB, uploaded 4 at a time.
test("a 100 MB file uploads multipart and is delivered end to end", async ({
  page,
}) => {
  test.setTimeout(480_000);
  await login(page, SEED_USERS.anna.email, SEED_USERS.anna.password);
  await page.goto("/upload");

  const partUploads: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (request.method() === "PUT" && url.includes("partNumber=")) {
      partUploads.push(url);
    }
  });

  const big = fixture("big-pdf");
  const bigName = path.basename(big);
  await page.locator('[data-testid="file-input"]').setInputFiles(big);
  await waitStaged(page, bigName, 240_000);
  expect(partUploads.length).toBeGreaterThanOrEqual(7);

  await page.getByRole("button", { name: "Expand all" }).click();
  await folderCheckbox(page, "Oncology Site A", "Binder 1", "Reports").click();
  const reports = folderPath("Oncology Site A", "Binder 1", "Reports");
  await page
    .getByRole("checkbox", { name: `Assign ${reports} to all files` })
    .click();
  await expect(
    page.getByText("Files 1/100 · Folders 1/20 · Tasks 1/2,000"),
  ).toBeVisible();

  const jobId = await submitComposedJob(page);
  await page.goto(`/jobs/${jobId}`);
  await waitJobCompleted(page, 240_000);
  await expect(page.getByText("1 of 1 tasks delivered")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page
    .locator("tr", { hasText: bigName })
    .getByRole("button", { name: "Download" })
    .click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  // Streamed hash — never holds both 100 MiB files in the worker's heap.
  expect(await sha256File(await download.path())).toBe(await sha256File(big));
});
