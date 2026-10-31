import { expect, test } from "@playwright/test";
import { runId } from "../fixtures";
import { login, SEED_USERS } from "./helpers";

// Flow 1: browse destinations — sign in, land on the destination tree
// filtered by the caller's team claims, expand and filter client-side.
test.describe("flow 1: authentication and destination tree", () => {
  test("anonymous users are redirected to login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await expect(
      page.getByRole("heading", { name: "Sign in to DocBridge" }),
    ).toBeVisible();
  });

  test("bad credentials show an error, valid ones land on the tree", async ({
    page,
  }) => {
    // A non-existent email gets the same invalid_credentials response, so the
    // bad attempt never burns attempts on a real account's throttle key.
    await page.goto("/login");
    await page.getByLabel("Email").fill(`e2e-nobody-${runId}@docbridge.local`);
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Email or password is incorrect.",
    );

    await page.getByLabel("Email").fill(SEED_USERS.anna.email);
    await page.getByLabel("Password").fill(SEED_USERS.anna.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Destinations" }),
    ).toBeVisible();
  });

  test("the tree is filtered by team claims and searchable", async ({
    page,
  }) => {
    await login(page, SEED_USERS.anna.email, SEED_USERS.anna.password);
    await page.goto("/");

    // Anna is a member of Oncology Site A and Central Regulatory, not
    // Cardiology Site B (seed memberships).
    await expect(
      page.getByRole("button", { name: "Oncology Site A", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Central Regulatory", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cardiology Site B" }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Expand all" }).click();
    await expect(
      page.getByText("2 teams · 4 binders · 12 folders"),
    ).toBeVisible();
    // An "Inbox" per binder: 2 teams × 2 binders proves expansion worked.
    // Expandable folders are buttons; the arrow is aria-hidden so the
    // accessible name is the folder name alone.
    await expect(
      page.getByRole("button", { name: "Inbox", exact: true }),
    ).toHaveCount(4);

    const filter = page.getByLabel("Filter destinations");
    await filter.fill("Reports");
    await expect(
      page.getByText("2 teams · 4 binders · 4 folders"),
    ).toBeVisible();
    await filter.fill("no-such-destination");
    await expect(page.getByText("No matches.")).toBeVisible();
  });
});
