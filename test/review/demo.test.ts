import { describe, expect, it } from "vitest";

import { createDemoReviewSnapshot } from "../../src/review/index.js";

describe("createDemoReviewSnapshot", () => {
  it("creates a review workspace snapshot with patchsets, files, threads, and attention", () => {
    const snapshot = createDemoReviewSnapshot({
      owner: "acme",
      pullNumber: 42,
      repo: "repo",
      viewerLogin: "alice",
    });

    expect(snapshot.pullRequest.htmlUrl).toBe("https://github.com/acme/repo/pull/42");
    expect(snapshot.patchsets).toHaveLength(5);
    expect(snapshot.patchsets.some((patchset) => patchset.forcePush)).toBe(true);
    expect(snapshot.files.some((file) => file.markState === "stale")).toBe(true);
    expect(snapshot.activity.newCommentCount).toBe(1);
    expect(snapshot.attention).toEqual(
      expect.objectContaining({
        isViewerTurn: true,
      }),
    );
    expect(snapshot.threads[0]?.anchor.status).toBe("moved");
  });
});
