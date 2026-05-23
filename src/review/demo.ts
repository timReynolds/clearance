import type { ReviewSnapshot } from "./types.js";

export function createDemoReviewSnapshot(input: {
  owner: string;
  pullNumber: number;
  repo: string;
  viewerLogin?: string;
}): ReviewSnapshot {
  const now = new Date().toISOString();

  return {
    activity: {
      lastVisitedAt: "2026-05-22T09:45:00.000Z",
      newCommentCount: 1,
    },
    attention: {
      isViewerTurn: true,
      members: [
        {
          addedAt: now,
          login: input.viewerLogin ?? "you",
          reason: "New patchset needs review",
        },
      ],
    },
    capabilities: {
      limitations: [
        "Demo data is synthetic and is not connected to GitHub.",
        "Review actions are not persisted unless a database and GitHub OAuth are configured.",
      ],
      mode: "demo",
    },
    comparison: {
      additions: 31,
      deletions: 9,
      fileCount: 4,
      fromPatchsetNumber: 2,
      toPatchsetNumber: 5,
    },
    files: [
      {
        additions: 16,
        deletions: 3,
        markState: "stale",
        markedPatchsetNumber: 2,
        path: "src/review/patchsets.ts",
        status: "modified",
        patch: demoPatch("src/review/patchsets.ts"),
      },
      {
        additions: 9,
        deletions: 0,
        markState: "unreviewed",
        path: "src/review/attention.ts",
        status: "added",
        patch: demoPatch("src/review/attention.ts"),
      },
      {
        additions: 4,
        deletions: 6,
        markState: "current",
        markedPatchsetNumber: 5,
        path: "src/github/review-native.ts",
        status: "modified",
        patch: demoPatch("src/github/review-native.ts"),
      },
      {
        additions: 2,
        deletions: 0,
        markState: "unreviewed",
        path: "docs/review-roadmap.md",
        status: "added",
        patch: demoPatch("docs/review-roadmap.md"),
      },
    ],
    patchsets: [
      {
        actor: "author",
        createdAt: "2026-05-20T10:15:00.000Z",
        eventType: "opened",
        forcePush: false,
        headSha: "8b7d98a",
        patchsetNumber: 1,
        reconstructed: true,
      },
      {
        actor: "author",
        createdAt: "2026-05-21T09:00:00.000Z",
        eventType: "synchronize",
        forcePush: false,
        headSha: "b19d20f",
        parentSha: "8b7d98a",
        patchsetNumber: 2,
        reconstructed: false,
      },
      {
        actor: "author",
        createdAt: "2026-05-21T16:25:00.000Z",
        eventType: "force_push",
        forcePush: true,
        headSha: "3f64a0b",
        parentSha: "b19d20f",
        patchsetNumber: 3,
        reconstructed: false,
      },
      {
        actor: "author",
        createdAt: "2026-05-22T11:10:00.000Z",
        eventType: "force_push",
        forcePush: true,
        headSha: "698f2cc",
        parentSha: "3f64a0b",
        patchsetNumber: 4,
        reconstructed: false,
      },
      {
        actor: "author",
        createdAt: now,
        eventType: "synchronize",
        forcePush: false,
        headSha: "e51a49a",
        parentSha: "698f2cc",
        patchsetNumber: 5,
        reconstructed: false,
      },
    ],
    pullRequest: {
      author: "author",
      headSha: "e51a49a",
      htmlUrl: `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`,
      number: input.pullNumber,
      owner: input.owner,
      repo: input.repo,
      state: "open",
      title: "Introduce GitHub-native review patchsets",
    },
    threads: [
      {
        anchor: {
          confidence: 0.82,
          currentLine: 18,
          currentPatchsetNumber: 5,
          currentPath: "src/review/patchsets.ts",
          originalLine: 14,
          originalPatchsetNumber: 2,
          originalPath: "src/review/patchsets.ts",
          side: "RIGHT",
          sourceText: "const patchsets = reconstructPatchsets(events);",
          status: "moved",
        },
        comments: [
          {
            author: { login: input.viewerLogin ?? "you" },
            body: "Can we make force-pushed patchsets visually distinct and still diffable?",
            createdAt: "2026-05-21T10:30:00.000Z",
            id: "demo-comment-1",
            mirroredToGithub: true,
            newSinceLastVisit: false,
          },
          {
            author: { login: "author" },
            body: "Yes. PS 3 and PS 4 carry the force-push marker and keep their own anchors.",
            createdAt: "2026-05-22T13:00:00.000Z",
            id: "demo-comment-2",
            mirroredToGithub: true,
            newSinceLastVisit: true,
          },
        ],
        id: "demo-thread-1",
        owner: { login: input.viewerLogin ?? "you" },
        status: "open",
      },
    ],
    viewer: input.viewerLogin === undefined ? undefined : { login: input.viewerLogin },
  };
}

function demoPatch(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 6d1f7a2..a4b9d70 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,6 +1,10 @@",
    " export function reviewFlow() {",
    '-  return "github files changed";',
    '+  const patchset = "PS 5";',
    '+  const attention = "your turn";',
    "+",
    "+  return `Clearance Review: ${patchset} / ${attention}`;",
    " }",
    " ",
    "-export const durableComments = false;",
    "+export const durableComments = true;",
    "+export const githubNative = true;",
    "",
  ].join("\n");
}
