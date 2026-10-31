import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { fixture } from "../fixtures";
import {
  folderCheckbox,
  folderPath,
  login,
  SEED_USERS,
  submitComposedJob,
  waitJobCompleted,
  waitStaged,
} from "./helpers";

// Flows 2-4 end to end: upload → map files to folders → submit the job →
// watch it reach Completed → download a delivered file back.
test("upload, map, submit, track to completion and download", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page, SEED_USERS.anna.email, SEED_USERS.anna.password);
  await page.goto("/");

  const pdf = fixture("pdf");
  const png = fixture("png");
  const pdfName = path.basename(pdf);
  const pngName = path.basename(png);
  await page.locator('[data-testid="file-input"]').setInputFiles([pdf, png]);
  await waitStaged(page, pdfName);
  await waitStaged(page, pngName);

  // Two destination folders in two different teams.
  await page.getByRole("button", { name: "Expand all" }).click();
  await folderCheckbox(page, "Oncology Site A", "Binder 1", "Inbox").click();
  await folderCheckbox(
    page,
    "Central Regulatory",
    "Binder 2",
    "Reports",
  ).click();

  // Assign every file to both folders through the matrix column headers.
  const inbox = folderPath("Oncology Site A", "Binder 1", "Inbox");
  const reports = folderPath("Central Regulatory", "Binder 2", "Reports");
  await page
    .getByRole("checkbox", { name: `Assign ${inbox} to all files` })
    .click();
  await page
    .getByRole("checkbox", { name: `Assign ${reports} to all files` })
    .click();
  await expect(
    page.getByText("Files 2/100 · Folders 2/20 · Tasks 4/2,000"),
  ).toBeVisible();

  const jobId = await submitComposedJob(page);

  // Flow 3: the job list and the live detail view.
  await page.goto("/jobs");
  await page
    .getByRole("link", { name: /20\d\d/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}`));
  await waitJobCompleted(page);
  await expect(page.getByText("4 of 4 tasks delivered")).toBeVisible();
  // TaskTable groups tasks under a section headed by the file name —
  // two task rows (one per folder), each showing the Completed badge.
  const pdfSection = page.locator("section", {
    has: page.getByRole("heading", { name: pdfName }),
  });
  await expect(pdfSection.getByText("Completed", { exact: true })).toHaveCount(
    2,
  );

  // Flow 4: the staged file downloads through a presigned URL, byte-identical.
  const downloadPromise = page.waitForEvent("download");
  await page
    .locator("tr", { hasText: pdfName })
    .getByRole("button", { name: "Download" })
    .click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  expect(fs.readFileSync(await download.path())).toEqual(fs.readFileSync(pdf));
});
