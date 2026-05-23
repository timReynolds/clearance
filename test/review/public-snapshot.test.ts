import { describe, expect, it } from "vitest";

import {
  getPublicThreadRootCommentId,
  loadPublicReviewSnapshot,
  type PublicPullRequestSnapshotOctokit,
} from "../../src/review/index.js";

describe("loadPublicReviewSnapshot", () => {
  it("builds a current public PR review snapshot from GitHub REST data", async () => {
    const octokit: PublicPullRequestSnapshotOctokit = {
      request: async <TResponse>(route: string): Promise<{ data: TResponse }> => {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return {
            data: {
              base: { sha: "base-sha" },
              created_at: "2026-05-23T09:00:00.000Z",
              head: { sha: "head-sha" },
              html_url: "https://github.com/acme/repo/pull/7",
              merged_at: null,
              state: "open",
              title: "Improve review flow",
              updated_at: "2026-05-23T10:00:00.000Z",
              user: { login: "author" },
            } as TResponse,
          };
        }

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
          return {
            data: [
              {
                additions: 2,
                deletions: 1,
                filename: "src/review.ts",
                patch:
                  "@@ -1,2 +1,3 @@\n-export const durable = false;\n+export const durable = true;\n+export const publicPreview = true;",
                status: "modified",
              },
            ] as TResponse,
          };
        }

        return {
          data: [
            {
              body: "Looks good.",
              created_at: "2026-05-23T10:30:00.000Z",
              diff_hunk:
                "@@ -1,2 +1,3 @@\n-export const durable = false;\n+export const durable = true;\n+export const publicPreview = true;",
              html_url: "https://github.com/acme/repo/pull/7#discussion_r1",
              id: 1,
              line: 1,
              path: "src/review.ts",
              side: "RIGHT",
              user: { avatar_url: "https://example.com/a.png", login: "reviewer" },
            },
          ] as TResponse,
        };
      },
    };

    const snapshot = await loadPublicReviewSnapshot(
      octokit,
      { owner: "acme", pullNumber: 7, repo: "repo" },
      "alice",
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        capabilities: expect.objectContaining({ mode: "public" }),
        comparison: expect.objectContaining({ additions: 2, deletions: 1, fileCount: 1 }),
        patchsets: [expect.objectContaining({ headSha: "head-sha", reconstructed: true })],
        pullRequest: expect.objectContaining({ title: "Improve review flow" }),
        viewer: { login: "alice" },
      }),
    );
    expect(snapshot?.files[0]?.patch).toContain("diff --git");
    expect(snapshot?.threads[0]?.id).toBe("github-comment-1");
    expect(snapshot?.threads[0]?.comments[0]?.body).toBe("Looks good.");
  });

  it("extracts GitHub comment ids from public thread ids", () => {
    expect(getPublicThreadRootCommentId("github-comment-123")).toBe(123);
    expect(getPublicThreadRootCommentId("thread-123")).toBeUndefined();
  });
});
