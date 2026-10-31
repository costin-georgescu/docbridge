import { expect, test } from "@playwright/test";
import { runId } from "../fixtures";
import { login, logout, SEED_USERS } from "./helpers";

// Admin user creation: an admin provisions a coordinator with a team, and
// that user can sign in and sees exactly the assigned destinations.
test("admin creates a user who can sign in with the assigned teams", async ({
  page,
}) => {
  const email = `e2e-${runId}@docbridge.local`;
  const password = "e2e-password-123";

  await login(page, SEED_USERS.admin.email, SEED_USERS.admin.password);
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();

  await page.getByRole("button", { name: "New user" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Display name").fill("E2E Coordinator");
  await dialog.getByLabel("Password").fill(password);
  await dialog
    .getByRole("checkbox", { name: "Oncology Site A", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Create user" }).click();

  await expect(dialog).toBeHidden();
  const row = page.locator("tr", { hasText: email });
  await expect(row).toContainText("E2E Coordinator");
  await expect(row).toContainText("Oncology Site A");
  await expect(row).toContainText("Active");

  await logout(page);
  await login(page, email, password);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Oncology Site A", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Central Regulatory" }),
  ).toHaveCount(0);
  await expect(page.getByText("1 teams · 2 binders · 6 folders")).toBeVisible();
});
