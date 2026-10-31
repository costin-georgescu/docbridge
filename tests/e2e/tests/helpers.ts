import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { expect, Page } from "@playwright/test";

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export const SEED_USERS = {
  admin: { email: "admin@docbridge.local", password: "password123" },
  anna: { email: "anna@docbridge.local", password: "password123" },
} as const;

export async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("link", { name: "Jobs" })).toBeVisible();
}

export async function logout(page: Page) {
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page).toHaveURL(/\/login/);
}

// Folders repeat names across binders and teams ("Inbox" everywhere), so the
// checkbox is scoped through the ancestor treeitems.
export function folderCheckbox(
  page: Page,
  team: string,
  binder: string,
  folder: string,
) {
  const teamItem = page.getByRole("treeitem").filter({
    has: page.getByRole("button", { name: team, exact: true }),
  });
  const binderItem = teamItem.getByRole("treeitem").filter({
    has: page.getByRole("button", { name: binder, exact: true }),
  });
  return binderItem.getByRole("checkbox", { name: folder, exact: true });
}

export function folderPath(team: string, binder: string, folder: string) {
  return `${team} / ${binder} / ${folder}`;
}

export async function waitStaged(
  page: Page,
  fileName: string,
  timeout = 60_000,
) {
  // The mapping grid shows each staged upload as a table row; the file name
  // is unique per run.
  const row = page.getByRole("row").filter({ hasText: fileName });
  await expect(row).toContainText("Staged", { timeout });
}

export async function submitComposedJob(page: Page) {
  // exact: the button text becomes "Submitting…" (disabled) on click.
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  const status = page.getByRole("status");
  await expect(status).toContainText("Job submitted.", { timeout: 30_000 });
  const jobId = (await status.textContent())?.match(
    /Job submitted\.\s*([0-9a-f-]{36})/,
  )?.[1];
  if (!jobId) {
    throw new Error("could not parse job id from the submission status");
  }
  return jobId;
}

export async function waitJobCompleted(page: Page, timeout = 120_000) {
  // Explicit loop rather than expect.poll so a terminal failure fails
  // immediately instead of waiting out the whole timeout.
  const deadline = Date.now() + timeout;
  for (;;) {
    const badge = (
      await page
        .locator("span.rounded-full")
        .filter({ hasText: /Completed|Failed/ })
        .first()
        .textContent()
        .catch(() => null)
    )?.trim();
    if (badge === "Completed") {
      return;
    }
    if (badge === "Failed" || badge === "Completed with failures") {
      throw new Error(`job reached a terminal state: ${badge}`);
    }
    if (Date.now() >= deadline) {
      throw new Error("timeout waiting for job to reach Completed");
    }
    await page.waitForTimeout(2_000);
  }
}
