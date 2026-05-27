import { describe, expect, it, vi } from "vitest";

import {
  loadReviewSnapshot,
  type LoadReviewSnapshotInput,
  type PublicPullRequestSnapshotOctokit,
  type ReviewSnapshot,
  type ReviewSnapshotStore,
} from "../../src/review/index.js";

describe("loadReviewSnapshot", () => {
  const ref = { owner: "public-org", pullNumber: 17, repo: "public-repo" };
  const publicOctokit: PublicPullRequestSnapshotOctokit = {
    request: async () => {
      throw new Error("unexpected public Octokit request");
    },
  };

  it("loads the indexed database snapshot first for an anonymous public route", async () => {
    const indexedSnapshot = createSnapshot("indexed");
    const reviewStore: ReviewSnapshotStore = {
      loadSnapshot: vi.fn<ReviewSnapshotStore["loadSnapshot"]>(async () => indexedSnapshot),
    };
    const loadPublicSnapshot = vi.fn<PublicSnapshotLoader>(async () => createSnapshot("public"));

    const snapshot = await loadReviewSnapshot({
      loadPublicSnapshot,
      options: { fromPatchsetNumber: 1, toPatchsetNumber: 2 },
      publicOctokit,
      ref,
      reviewStore,
      viewerLogin: undefined,
    });

    expect(snapshot).toBe(indexedSnapshot);
    expect(reviewStore.loadSnapshot).toHaveBeenCalledWith(ref, undefined, {
      fromPatchsetNumber: 1,
      toPatchsetNumber: 2,
    });
    expect(loadPublicSnapshot).not.toHaveBeenCalled();
  });

  it("falls back to the public GitHub snapshot when the database has no indexed PR", async () => {
    const publicSnapshot = createSnapshot("public", "alice");
    const reviewStore: ReviewSnapshotStore = {
      loadSnapshot: vi.fn<ReviewSnapshotStore["loadSnapshot"]>(async () => undefined),
    };
    const loadPublicSnapshot = vi.fn<PublicSnapshotLoader>(async () => publicSnapshot);

    const snapshot = await loadReviewSnapshot({
      loadPublicSnapshot,
      publicOctokit,
      ref,
      reviewStore,
      viewerLogin: "alice",
    });

    expect(snapshot).toBe(publicSnapshot);
    expect(reviewStore.loadSnapshot).toHaveBeenCalledWith(ref, "alice", undefined);
    expect(loadPublicSnapshot).toHaveBeenCalledWith(publicOctokit, ref, "alice");
  });

  it("propagates database failures instead of silently treating the DB as absent", async () => {
    const reviewStore: ReviewSnapshotStore = {
      loadSnapshot: vi.fn<ReviewSnapshotStore["loadSnapshot"]>(async () => {
        throw new Error("database unavailable");
      }),
    };
    const loadPublicSnapshot = vi.fn<PublicSnapshotLoader>(async () => createSnapshot("public"));

    await expect(
      loadReviewSnapshot({
        loadPublicSnapshot,
        publicOctokit,
        ref,
        reviewStore,
      }),
    ).rejects.toThrow("database unavailable");
    expect(loadPublicSnapshot).not.toHaveBeenCalled();
  });
});

type PublicSnapshotLoader = NonNullable<LoadReviewSnapshotInput["loadPublicSnapshot"]>;

function createSnapshot(
  mode: ReviewSnapshot["capabilities"]["mode"],
  viewerLogin?: string,
): ReviewSnapshot {
  return {
    activity: {
      newCommentCount: 0,
    },
    attention: {
      isViewerTurn: false,
      members: [],
    },
    capabilities: {
      limitations: [],
      mode,
    },
    comparison: {
      additions: 1,
      deletions: 0,
      fileCount: 1,
      fromPatchsetNumber: 1,
      toPatchsetNumber: 1,
    },
    files: [
      {
        additions: 1,
        deletions: 0,
        markState: "unreviewed",
        path: "src/index.ts",
        status: "modified",
      },
    ],
    patchsets: [
      {
        createdAt: "2026-05-23T12:00:00.000Z",
        eventType: mode === "public" ? "reconstructed" : "opened",
        forcePush: false,
        headSha: "head-sha",
        patchsetNumber: 1,
        reconstructed: mode === "public",
      },
    ],
    pullRequest: {
      author: "author",
      headSha: "head-sha",
      htmlUrl: "https://github.com/public-org/public-repo/pull/17",
      number: 17,
      owner: "public-org",
      repo: "public-repo",
      state: "open",
      title: "Public PR",
    },
    reviewState: {
      dryRun: false,
      requirements: [],
      warnings: [],
    },
    threads: [],
    viewer: viewerLogin === undefined ? undefined : { login: viewerLogin },
  };
}
