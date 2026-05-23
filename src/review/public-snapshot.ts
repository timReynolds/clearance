import { stripReviewThreadMarker } from "../github/review-native.js";
import type { ReviewFile, ReviewFileStatus, ReviewSnapshot, ReviewThread } from "./types.js";

export type PublicPullRequestSnapshotOctokit = {
  request<TResponse>(
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<{ data: TResponse }>;
};

export type PublicPullRequestRef = {
  owner: string;
  pullNumber: number;
  repo: string;
};

type PublicPullRequestResponse = {
  base: {
    sha?: string;
  };
  created_at?: string;
  head: {
    sha: string;
  };
  html_url: string;
  merged_at?: string | null;
  state?: string;
  title: string;
  updated_at?: string;
  user?: {
    login?: string;
  } | null;
};

type PublicPullRequestFileResponse = {
  additions?: number;
  deletions?: number;
  filename: string;
  patch?: string;
  previous_filename?: string;
  status?: string;
};

type PublicPullRequestReviewCommentResponse = {
  body?: string;
  created_at?: string;
  diff_hunk?: string;
  html_url?: string;
  id: number;
  in_reply_to_id?: number | null;
  line?: number | null;
  original_line?: number | null;
  path: string;
  side?: string;
  user?: {
    avatar_url?: string;
    login?: string;
  } | null;
};

export async function loadPublicReviewSnapshot(
  octokit: PublicPullRequestSnapshotOctokit,
  ref: PublicPullRequestRef,
  viewerLogin: string | undefined,
): Promise<ReviewSnapshot | undefined> {
  try {
    const [pullRequest, files, comments] = await Promise.all([
      loadPublicPullRequest(octokit, ref),
      loadPublicPullRequestFiles(octokit, ref),
      loadPublicPullRequestReviewComments(octokit, ref),
    ]);

    return buildPublicReviewSnapshot(ref, pullRequest, files, comments, viewerLogin);
  } catch (error) {
    if (isGitHubNotFound(error)) {
      return undefined;
    }

    throw error;
  }
}

async function loadPublicPullRequest(
  octokit: PublicPullRequestSnapshotOctokit,
  ref: PublicPullRequestRef,
): Promise<PublicPullRequestResponse> {
  const response = await octokit.request<PublicPullRequestResponse>(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner: ref.owner,
      pull_number: ref.pullNumber,
      repo: ref.repo,
    },
  );

  return response.data;
}

async function loadPublicPullRequestFiles(
  octokit: PublicPullRequestSnapshotOctokit,
  ref: PublicPullRequestRef,
  page = 1,
): Promise<PublicPullRequestFileResponse[]> {
  const response = await octokit.request<PublicPullRequestFileResponse[]>(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    {
      owner: ref.owner,
      page,
      per_page: 100,
      pull_number: ref.pullNumber,
      repo: ref.repo,
    },
  );

  if (response.data.length < 100) {
    return response.data;
  }

  return [...response.data, ...(await loadPublicPullRequestFiles(octokit, ref, page + 1))];
}

async function loadPublicPullRequestReviewComments(
  octokit: PublicPullRequestSnapshotOctokit,
  ref: PublicPullRequestRef,
  page = 1,
): Promise<PublicPullRequestReviewCommentResponse[]> {
  const response = await octokit.request<PublicPullRequestReviewCommentResponse[]>(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
    {
      owner: ref.owner,
      page,
      per_page: 100,
      pull_number: ref.pullNumber,
      repo: ref.repo,
    },
  );

  if (response.data.length < 100) {
    return response.data;
  }

  return [...response.data, ...(await loadPublicPullRequestReviewComments(octokit, ref, page + 1))];
}

function buildPublicReviewSnapshot(
  ref: PublicPullRequestRef,
  pullRequest: PublicPullRequestResponse,
  files: PublicPullRequestFileResponse[],
  comments: PublicPullRequestReviewCommentResponse[],
  viewerLogin: string | undefined,
): ReviewSnapshot {
  const author = pullRequest.user?.login ?? "unknown";
  const createdAt = pullRequest.created_at ?? new Date().toISOString();
  const reviewFiles = files.map(mapPublicReviewFile);

  return {
    activity: {
      newCommentCount: 0,
    },
    attention: {
      isViewerTurn: false,
      members: [
        {
          addedAt: pullRequest.updated_at ?? createdAt,
          login: author,
          reason: "Public preview; turn state is not indexed",
        },
      ],
    },
    capabilities: {
      limitations: [
        "Only the current PR diff is available; historical patchsets need app indexing or timeline backfill.",
        "Force-push and rebase-only detection is unavailable from the public REST snapshot.",
        "Review marks and attention changes require this pull request to be indexed by Clearance.",
        "Commenting, replying, approving, and viewed-file mirroring require GitHub OAuth and normal GitHub permissions.",
        "Thread resolution for existing public comments is read-only until GraphQL thread ids are indexed.",
      ],
      mode: "public",
    },
    comparison: {
      additions: reviewFiles.reduce((total, file) => total + file.additions, 0),
      deletions: reviewFiles.reduce((total, file) => total + file.deletions, 0),
      fileCount: reviewFiles.length,
      fromPatchsetNumber: 1,
      toPatchsetNumber: 1,
    },
    files: reviewFiles,
    patchsets: [
      {
        actor: author,
        baseSha: pullRequest.base.sha,
        createdAt,
        eventType: "reconstructed",
        forcePush: false,
        headSha: pullRequest.head.sha,
        patchsetNumber: 1,
        reconstructed: true,
      },
    ],
    pullRequest: {
      author,
      headSha: pullRequest.head.sha,
      htmlUrl: pullRequest.html_url,
      number: ref.pullNumber,
      owner: ref.owner,
      repo: ref.repo,
      state: getPublicPullRequestState(pullRequest),
      title: pullRequest.title,
    },
    threads: buildPublicReviewThreads(comments),
    viewer: viewerLogin === undefined ? undefined : { login: viewerLogin },
  };
}

function mapPublicReviewFile(file: PublicPullRequestFileResponse): ReviewFile {
  return {
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    markState: "unreviewed",
    patch: buildPublicFilePatch(file),
    path: file.filename,
    previousPath: file.previous_filename,
    status: mapPublicFileStatus(file.status),
  };
}

function buildPublicReviewThreads(
  comments: PublicPullRequestReviewCommentResponse[],
): ReviewThread[] {
  const threadsById = new Map<string, ReviewThread>();
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));

  for (const comment of comments) {
    const rootCommentId = comment.in_reply_to_id ?? comment.id;
    const rootComment = commentsById.get(rootCommentId) ?? comment;
    const threadId = getPublicThreadId(rootCommentId);
    const line = rootComment.line ?? rootComment.original_line ?? 1;
    const side = rootComment.side === "LEFT" ? "LEFT" : "RIGHT";
    const owner = rootComment.user?.login ?? "unknown";

    if (!threadsById.has(threadId)) {
      threadsById.set(threadId, {
        anchor: {
          confidence: rootComment.line === null || rootComment.line === undefined ? 0.5 : 0.7,
          currentLine: rootComment.line ?? undefined,
          currentPatchsetNumber:
            rootComment.line === null || rootComment.line === undefined ? undefined : 1,
          currentPath: rootComment.path,
          originalLine: line,
          originalPatchsetNumber: 1,
          originalPath: rootComment.path,
          side,
          sourceText: getReviewCommentSourceText(rootComment.diff_hunk, line, side) ?? "",
          status:
            rootComment.line === null || rootComment.line === undefined ? "uncertain" : "current",
        },
        comments: [],
        id: threadId,
        owner: { avatarUrl: rootComment.user?.avatar_url, login: owner },
        status: "open",
      });
    }

    const thread = threadsById.get(threadId);
    if (thread === undefined) {
      continue;
    }

    thread.comments.push({
      author: {
        avatarUrl: comment.user?.avatar_url,
        login: comment.user?.login ?? "unknown",
      },
      body: stripReviewThreadMarker(comment.body ?? ""),
      createdAt: comment.created_at ?? new Date().toISOString(),
      githubUrl: comment.html_url,
      id: `github-comment-${comment.id}`,
      mirroredToGithub: true,
      newSinceLastVisit: false,
    });
  }

  return [...threadsById.values()].filter((thread) => thread.comments.length > 0);
}

export function getPublicThreadRootCommentId(threadId: string): number | undefined {
  if (!threadId.startsWith("github-comment-")) {
    return undefined;
  }

  const parsed = Number.parseInt(threadId.slice("github-comment-".length), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getPublicThreadId(commentId: number): string {
  return `github-comment-${commentId}`;
}

function buildPublicFilePatch(file: PublicPullRequestFileResponse): string | undefined {
  if (file.patch === undefined || file.patch.trim() === "") {
    return undefined;
  }

  if (file.patch.startsWith("diff --git")) {
    return file.patch;
  }

  const previousPath = file.previous_filename ?? file.filename;
  const oldPath = file.status === "added" ? "/dev/null" : `a/${previousPath}`;
  const newPath = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;

  return [
    `diff --git a/${previousPath} b/${file.filename}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    file.patch,
  ].join("\n");
}

function mapPublicFileStatus(status: string | undefined): ReviewFileStatus {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "changed":
    case "copied":
    case "modified":
    default:
      return "modified";
  }
}

function getPublicPullRequestState(
  pullRequest: PublicPullRequestResponse,
): "closed" | "merged" | "open" | "unknown" {
  if (pullRequest.merged_at !== null && pullRequest.merged_at !== undefined) {
    return "merged";
  }

  if (pullRequest.state === "open" || pullRequest.state === "closed") {
    return pullRequest.state;
  }

  return "unknown";
}

function getReviewCommentSourceText(
  diffHunk: string | undefined,
  lineNumber: number | undefined,
  side: "LEFT" | "RIGHT",
): string | undefined {
  if (diffHunk === undefined || lineNumber === undefined) {
    return undefined;
  }

  let leftLineNumber: number | undefined;
  let rightLineNumber: number | undefined;

  for (const rawLine of diffHunk.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk?.[1] !== undefined && hunk[2] !== undefined) {
      leftLineNumber = Number.parseInt(hunk[1], 10);
      rightLineNumber = Number.parseInt(hunk[2], 10);
      continue;
    }

    if (leftLineNumber === undefined || rightLineNumber === undefined) {
      continue;
    }

    if (rawLine.startsWith("+")) {
      if (side === "RIGHT" && rightLineNumber === lineNumber) {
        return rawLine.slice(1);
      }
      rightLineNumber += 1;
      continue;
    }

    if (rawLine.startsWith("-")) {
      if (side === "LEFT" && leftLineNumber === lineNumber) {
        return rawLine.slice(1);
      }
      leftLineNumber += 1;
      continue;
    }

    if (rawLine.startsWith(" ")) {
      if (
        (side === "LEFT" && leftLineNumber === lineNumber) ||
        (side === "RIGHT" && rightLineNumber === lineNumber)
      ) {
        return rawLine.slice(1);
      }
      leftLineNumber += 1;
      rightLineNumber += 1;
    }
  }

  return undefined;
}

function isGitHubNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}
