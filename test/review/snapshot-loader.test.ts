import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommitCompareOctokit } from "../../src/github/commit-compare.js";
import {
  loadReviewSnapshot,
  type LoadReviewSnapshotInput,
  type PublicPullRequestSnapshotOctokit,
  type ReviewSnapshot,
} from "../../src/review/index.js";

afterEach(() => vi.restoreAllMocks());

describe("loadReviewSnapshot", () => {
  it("compares selected patchsets and keeps review marks across a rename", async () => {
    const indexedSnapshot = createComparedSnapshot();
    indexedSnapshot.files = [
      {
        additions: 10,
        deletions: 5,
        markState: "current",
        markedAt: "2026-05-23T13:05:00.000Z",
        markedPatchsetNumber: 2,
        path: "src/index.ts",
        status: "modified",
      },
    ];

    const snapshot = await loadReviewSnapshot(
      createInput(indexedSnapshot, {
        getComparisonOctokit: async () => ({
          rest: {
            repos: {
              compareCommitsWithBasehead: async (parameters) => {
                if (
                  parameters.basehead !== "head-sha...next-sha" ||
                  parameters.owner !== "public-org" ||
                  parameters.repo !== "public-repo"
                ) {
                  throw new Error("wrong selected comparison");
                }
                return {
                  data: {
                    files: [
                      {
                        additions: 2,
                        deletions: 1,
                        filename: "src/main.ts",
                        previous_filename: "src/index.ts",
                        status: "renamed",
                        patch: "@@ -1 +1,2 @@\n-old\n+new\n+extra",
                      },
                    ],
                  },
                };
              },
            },
          },
        }),
      }),
    );

    expect(snapshot?.comparison).toEqual({
      additions: 2,
      deletions: 1,
      fileCount: 1,
      fromPatchsetNumber: 1,
      toPatchsetNumber: 2,
    });
    expect(snapshot?.files).toEqual([
      {
        additions: 2,
        deletions: 1,
        markState: "current",
        markedAt: "2026-05-23T13:05:00.000Z",
        markedPatchsetNumber: 2,
        patch:
          "diff --git a/src/index.ts b/src/main.ts\n--- a/src/index.ts\n+++ b/src/main.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra",
        path: "src/main.ts",
        previousPath: "src/index.ts",
        status: "renamed",
      },
    ]);
    expect(indexedSnapshot.files[0]?.path).toBe("src/index.ts");
  });

  it("normalizes added, deleted and binary files while retaining marks by current path", async () => {
    const indexedSnapshot = createComparedSnapshot();
    indexedSnapshot.files[0] = {
      additions: 1,
      deletions: 0,
      markState: "stale",
      markedAt: "2026-05-23T12:30:00.000Z",
      markedPatchsetNumber: 1,
      path: "src/index.ts",
      status: "modified",
    };
    const snapshot = await loadReviewSnapshot(
      createInput(indexedSnapshot, {
        getComparisonOctokit: async () =>
          createComparisonOctokit([
            { filename: "new.ts", additions: 1, status: "added", patch: "@@ -0,0 +1 @@\n+new" },
            { filename: "old.ts", deletions: 1, status: "removed", patch: "@@ -1 +0,0 @@\n-old" },
            { filename: "image.png", status: "modified", patch: " " },
            {
              filename: "src/index.ts",
              status: "modified",
              patch: "diff --git a/src/index.ts b/src/index.ts\nexisting patch",
            },
          ]),
      }),
    );
    expect(snapshot?.files).toMatchObject([
      { path: "image.png", status: "modified", patch: undefined, markState: "unreviewed" },
      {
        path: "new.ts",
        additions: 1,
        deletions: 0,
        status: "added",
        patch: "diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new",
      },
      {
        path: "old.ts",
        additions: 0,
        deletions: 1,
        status: "deleted",
        patch: "diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old",
      },
      {
        path: "src/index.ts",
        markState: "stale",
        markedAt: "2026-05-23T12:30:00.000Z",
        markedPatchsetNumber: 1,
        patch: "diff --git a/src/index.ts b/src/index.ts\nexisting patch",
      },
    ]);
  });

  it("shows an empty comparison when the selected heads have no content changes", async () => {
    const snapshot = await loadReviewSnapshot(
      createInput(createComparedSnapshot(), {
        getComparisonOctokit: async () => createComparisonOctokit([]),
      }),
    );

    expect(snapshot?.files).toEqual([]);
    expect(snapshot?.comparison).toEqual({
      additions: 0,
      deletions: 0,
      fileCount: 0,
      fromPatchsetNumber: 1,
      toPatchsetNumber: 2,
    });
    expect(snapshot?.capabilities.limitations).toEqual([]);
  });

  it.each(["client lookup", "commit comparison"])(
    "keeps indexed data and an explicit limitation when %s fails",
    async (failure) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const indexedSnapshot = createComparedSnapshot();
      indexedSnapshot.capabilities.limitations = ["Existing limitation"];
      const snapshot = await loadReviewSnapshot(
        createInput(indexedSnapshot, {
          getComparisonOctokit: async () => {
            if (failure === "client lookup") throw new Error("installation unavailable");
            return {
              rest: {
                repos: {
                  compareCommitsWithBasehead: async () => {
                    throw new Error("comparison unavailable");
                  },
                },
              },
            };
          },
        }),
      );

      expect(snapshot).toEqual({
        ...indexedSnapshot,
        capabilities: {
          mode: "indexed",
          limitations: [
            "Existing limitation",
            "Exact GitHub commit comparison is unavailable; showing the indexed patchset snapshot.",
          ],
        },
      });
      expect(indexedSnapshot.capabilities.limitations).toEqual(["Existing limitation"]);
    },
  );

  it.each([
    { fromPatchsetNumber: 1, toPatchsetNumber: 1 },
    { fromPatchsetNumber: 2, toPatchsetNumber: 1 },
    { fromPatchsetNumber: 1, toPatchsetNumber: 3 },
  ])("keeps the index when the selected patchsets cannot be compared: %j", async (selection) => {
    const indexedSnapshot = createComparedSnapshot();
    indexedSnapshot.comparison = { ...indexedSnapshot.comparison, ...selection };
    const snapshot = await loadReviewSnapshot(createInput(indexedSnapshot));
    expect(snapshot).toEqual(indexedSnapshot);
  });

  it("loads the viewer's selected indexed snapshot before trying public GitHub", async () => {
    const indexedSnapshot = createSnapshot("indexed", "alice");
    const input = createInput(undefined, {
      options: { fromPatchsetNumber: 1, toPatchsetNumber: 1 },
      reviewStore: {
        loadSnapshot: async (ref, viewer, options) => {
          if (
            ref.owner === "public-org" &&
            ref.repo === "public-repo" &&
            ref.pullNumber === 17 &&
            viewer === "alice" &&
            options?.fromPatchsetNumber === 1 &&
            options.toPatchsetNumber === 1
          ) {
            return indexedSnapshot;
          }
          throw new Error("unexpected viewer or patchset selection");
        },
      },
      viewerLogin: "alice",
    });

    expect(await loadReviewSnapshot(input)).toEqual(indexedSnapshot);
  });

  it("builds the public snapshot when the database has no indexed PR", async () => {
    const snapshot = await loadReviewSnapshot(
      createInput(undefined, {
        publicOctokit: createPublicOctokit(),
        viewerLogin: "alice",
      }),
    );

    expect(snapshot).toMatchObject({
      capabilities: { mode: "public" },
      comparison: { additions: 2, deletions: 1, fileCount: 1 },
      patchsets: [{ headSha: "public-head-sha", reconstructed: true }],
      pullRequest: { owner: "public-org", repo: "public-repo", number: 17, title: "Public PR" },
      viewer: { login: "alice" },
    });
    expect(snapshot?.capabilities.limitations).toContain(
      "Review marks and attention changes require this pull request to be indexed by Clearance.",
    );
    expect(snapshot?.files[0]?.patch).toBe(
      "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra",
    );
    expect(snapshot?.threads[0]).toMatchObject({
      id: "github-comment-1",
      comments: [{ body: "Looks good." }],
    });
  });

  it("returns absent only when both the index and GitHub cannot find the PR", async () => {
    const snapshot = await loadReviewSnapshot(
      createInput(undefined, {
        publicOctokit: {
          request: async () => {
            throw { status: 404 };
          },
        },
      }),
    );
    expect(snapshot).toBeUndefined();
  });

  it("propagates database failures instead of hiding them behind a public snapshot", async () => {
    await expect(
      loadReviewSnapshot(
        createInput(undefined, {
          publicOctokit: createPublicOctokit(),
          reviewStore: {
            loadSnapshot: async () => {
              throw new Error("database unavailable");
            },
          },
        }),
      ),
    ).rejects.toThrow("database unavailable");
  });

  it("propagates public GitHub failures other than not found", async () => {
    await expect(
      loadReviewSnapshot(
        createInput(undefined, {
          publicOctokit: {
            request: async () => {
              throw new Error("GitHub unavailable");
            },
          },
        }),
      ),
    ).rejects.toThrow("GitHub unavailable");
  });
});

type ComparisonFiles = NonNullable<
  Awaited<
    ReturnType<CommitCompareOctokit["rest"]["repos"]["compareCommitsWithBasehead"]>
  >["data"]["files"]
>;

function createComparisonOctokit(files: ComparisonFiles): CommitCompareOctokit {
  return { rest: { repos: { compareCommitsWithBasehead: async () => ({ data: { files } }) } } };
}

function createInput(
  indexedSnapshot: ReviewSnapshot | undefined,
  overrides: Partial<LoadReviewSnapshotInput> = {},
): LoadReviewSnapshotInput {
  return {
    getComparisonOctokit: async () => {
      throw new Error("unexpected commit comparison");
    },
    publicOctokit: {
      request: async () => {
        throw new Error("unexpected public request");
      },
    },
    ref: { owner: "public-org", pullNumber: 17, repo: "public-repo" },
    reviewStore: { loadSnapshot: async () => indexedSnapshot },
    ...overrides,
  };
}

function createComparedSnapshot(): ReviewSnapshot {
  const snapshot = createSnapshot("indexed");
  snapshot.patchsets.push({
    createdAt: "2026-05-23T13:00:00.000Z",
    eventType: "synchronize",
    forcePush: false,
    headSha: "next-sha",
    patchsetNumber: 2,
    reconstructed: false,
  });
  snapshot.comparison.toPatchsetNumber = 2;
  return snapshot;
}

function createPublicOctokit(): PublicPullRequestSnapshotOctokit {
  const responses: Record<string, unknown> = {
    "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
      base: { sha: "base-sha" },
      created_at: "2026-05-23T09:00:00.000Z",
      head: { sha: "public-head-sha" },
      html_url: "https://github.com/public-org/public-repo/pull/17",
      state: "open",
      title: "Public PR",
      user: { login: "author" },
    },
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": [
      {
        additions: 2,
        deletions: 1,
        filename: "src/index.ts",
        patch: "@@ -1 +1,2 @@\n-old\n+new\n+extra",
        status: "modified",
      },
    ],
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": [
      {
        body: "Looks good.",
        created_at: "2026-05-23T10:30:00.000Z",
        id: 1,
        line: 1,
        path: "src/index.ts",
        side: "RIGHT",
        user: { login: "reviewer" },
      },
    ],
  };
  return {
    request: async <TResponse>(route: string): Promise<{ data: TResponse }> => {
      if (!(route in responses)) throw new Error(`unexpected public request: ${route}`);
      return { data: responses[route] as TResponse };
    },
  };
}

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
