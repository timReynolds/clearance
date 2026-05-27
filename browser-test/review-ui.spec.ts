import { expect, test, type Page } from "@playwright/test";

import type { ReviewSnapshot } from "../src/review/types";

test("renders the review page with mocked API data", async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/review/acme/repo/pull/1");

  await expect(page.getByText("Use shadcn with Base UI")).toBeVisible();
  await expect(page.getByRole("button", { name: "web/main.tsx" })).toBeVisible();
  await expect(page.getByText("PS 1 to PS 2")).toBeVisible();
  await expect(page.getByText("Unexpected token")).toHaveCount(0);
});

test("submits a review through shadcn button actions", async ({ page }) => {
  const actions = await mockReviewApi(page);
  await page.goto("/review/acme/repo/pull/1");

  await page.locator("summary.review-button", { hasText: "Review" }).click();
  await page.getByRole("button", { name: "Approve" }).click();

  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({
    body: { event: "APPROVE" },
    pathname: "/api/review/acme/repo/pull/1/reviews",
  });
});

test("shows patchset tooltip content from the shadcn tooltip wrapper", async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/review/acme/repo/pull/1");

  await page.locator(".patchset", { hasText: "PS 2" }).hover();

  await expect(page.getByText("synchronize")).toBeVisible();
});

test("applies the compact code-first shadcn theme tokens", async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/review/acme/repo/pull/1");

  const theme = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);

    return {
      fontFamily: rootStyle.fontFamily,
      radius: rootStyle.getPropertyValue("--radius").trim(),
    };
  });

  expect(theme.fontFamily).toContain("JetBrains Mono");
  expect(theme.radius).toBe("0.45rem");
});

test("filters the changed file list", async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/review/acme/repo/pull/1");

  const fileTable = page.locator(".file-table");
  await page.getByLabel("Filter changed files").fill("styles");

  await expect(fileTable.getByRole("button", { name: "web/styles.css" })).toBeVisible();
  await expect(fileTable.getByRole("button", { name: "web/main.tsx" })).toHaveCount(0);
});

test("persists diff option changes", async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/review/acme/repo/pull/1");

  await page.locator("summary.review-button", { hasText: "Options" }).click();
  await page.locator(".diff-options-popover").getByRole("button", { name: "Split" }).click();
  await page.getByRole("switch", { name: "Wrapping" }).click();

  const diffOptions = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("clearance.diffOptions") ?? "{}"),
  );

  expect(diffOptions).toMatchObject({
    diffStyle: "split",
    wrapping: true,
  });
});

test("requests a patchset comparison when the rail selection changes", async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/review/acme/repo/pull/1");

  const comparisonRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());

    return (
      url.pathname === "/api/review/acme/repo/pull/1" &&
      url.searchParams.get("from") === "1" &&
      url.searchParams.get("to") === "1"
    );
  });

  await page.locator(".patchset", { hasText: "PS 1" }).click();
  await comparisonRequest;

  await expect(page.getByText("PS 1 to PS 1")).toBeVisible();
});

test("passes reviewer attention", async ({ page }) => {
  const actions = await mockReviewApi(page);
  await page.goto("/review/acme/repo/pull/1");

  await page.locator("summary.review-button", { hasText: "Pass" }).click();
  await page.getByLabel("Pass attention to").fill("sarah");
  await page.locator(".pass-popover").getByRole("button", { name: "Pass" }).click();

  await expect
    .poll(() => actions.some((action) => action.pathname.endsWith("/attention/pass")))
    .toBe(true);
  expect(actions.find((action) => action.pathname.endsWith("/attention/pass"))).toMatchObject({
    body: { targetLogin: "sarah" },
    pathname: "/api/review/acme/repo/pull/1/attention/pass",
  });
});

test("marks a file as viewed", async ({ page }) => {
  const actions = await mockReviewApi(page);
  await page.goto("/review/acme/repo/pull/1");

  const fileSection = page.locator("section.file-diff-section", { hasText: "web/main.tsx" });
  await fileSection.getByRole("button", { name: "Viewed" }).click();

  await expect.poll(() => actions.some((action) => action.pathname.endsWith("/marks"))).toBe(true);
  expect(actions.find((action) => action.pathname.endsWith("/marks"))).toMatchObject({
    body: {
      filePath: "web/main.tsx",
      patchsetNumber: 2,
    },
    pathname: "/api/review/acme/repo/pull/1/marks",
  });
  await expect(fileSection.getByRole("button", { name: "Viewed" })).toHaveClass(/viewed/);
});

test("creates a file-level review thread", async ({ page }) => {
  const actions = await mockReviewApi(page);
  await page.goto("/review/acme/repo/pull/1");

  const fileSection = page.locator("section.file-diff-section", { hasText: "web/main.tsx" });
  await fileSection.locator("summary.file-comment-button").click();
  await fileSection
    .getByLabel("New file review comment on web/main.tsx")
    .fill("Please double-check this UI state.");
  await fileSection
    .locator(".file-comment-submit")
    .getByRole("button", { name: "Comment" })
    .click();

  await expect
    .poll(() => actions.some((action) => action.pathname.endsWith("/threads")))
    .toBe(true);
  expect(actions.find((action) => action.pathname.endsWith("/threads"))).toMatchObject({
    body: {
      body: "Please double-check this UI state.",
      commitSha: "2222222222222222222222222222222222222222",
      filePath: "web/main.tsx",
      patchsetNumber: 2,
    },
    pathname: "/api/review/acme/repo/pull/1/threads",
  });
});

async function mockReviewApi(page: Page): Promise<ActionRequest[]> {
  const actionRequests: ActionRequest[] = [];

  await page.route("**/api/me?**", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        authenticated: true,
        csrfToken: "csrf-token",
        viewer: {
          avatarUrl: "https://example.test/tim.png",
          login: "tim",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.route("**/api/review/acme/repo/pull/1**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === "POST") {
      actionRequests.push({
        body: request.postDataJSON(),
        pathname: url.pathname,
      });

      await route.fulfill({
        body: JSON.stringify({ ok: true }),
        contentType: "application/json",
        status: 200,
      });
      return;
    }

    await route.fulfill({
      body: JSON.stringify(buildReviewSnapshotForUrl(url)),
      contentType: "application/json",
      status: 200,
    });
  });

  return actionRequests;
}

type ActionRequest = {
  body: unknown;
  pathname: string;
};

function buildReviewSnapshotForUrl(url: URL): ReviewSnapshot {
  const fromPatchsetNumber = Number.parseInt(url.searchParams.get("from") ?? "", 10);
  const toPatchsetNumber = Number.parseInt(url.searchParams.get("to") ?? "", 10);

  return {
    ...reviewSnapshot,
    comparison: {
      ...reviewSnapshot.comparison,
      fromPatchsetNumber: Number.isNaN(fromPatchsetNumber)
        ? reviewSnapshot.comparison.fromPatchsetNumber
        : fromPatchsetNumber,
      toPatchsetNumber: Number.isNaN(toPatchsetNumber)
        ? reviewSnapshot.comparison.toPatchsetNumber
        : toPatchsetNumber,
    },
  };
}

const reviewSnapshot: ReviewSnapshot = {
  activity: {
    newCommentCount: 1,
  },
  attention: {
    isViewerTurn: true,
    members: [
      {
        addedAt: "2026-05-27T09:00:00.000Z",
        login: "tim",
        reason: "review requested",
      },
    ],
  },
  capabilities: {
    limitations: [],
    mode: "indexed",
  },
  comparison: {
    additions: 12,
    deletions: 3,
    fileCount: 2,
    fromPatchsetNumber: 1,
    toPatchsetNumber: 2,
  },
  files: [
    {
      additions: 8,
      deletions: 2,
      markState: "unreviewed",
      path: "web/main.tsx",
      status: "modified",
    },
    {
      additions: 4,
      deletions: 1,
      markState: "current",
      markedAt: "2026-05-27T09:15:00.000Z",
      markedPatchsetNumber: 2,
      path: "web/styles.css",
      status: "modified",
    },
  ],
  patchsets: [
    {
      createdAt: "2026-05-27T08:30:00.000Z",
      eventType: "opened",
      forcePush: false,
      headSha: "1111111111111111111111111111111111111111",
      patchsetNumber: 1,
      reconstructed: false,
    },
    {
      createdAt: "2026-05-27T09:30:00.000Z",
      eventType: "synchronize",
      forcePush: false,
      headSha: "2222222222222222222222222222222222222222",
      patchsetNumber: 2,
      reconstructed: false,
    },
  ],
  pullRequest: {
    author: "tim",
    headSha: "2222222222222222222222222222222222222222",
    htmlUrl: "https://github.com/acme/repo/pull/1",
    number: 1,
    owner: "acme",
    repo: "repo",
    state: "open",
    title: "Use shadcn with Base UI",
  },
  threads: [],
  viewer: {
    avatarUrl: "https://example.test/tim.png",
    login: "tim",
  },
};
