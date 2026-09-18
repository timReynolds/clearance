import { randomUUID } from "node:crypto";

import {
  createGithubReviewThreadComment,
  findGithubPullRequestNodeId,
  findGithubReviewThreadNodeIdForComment,
  markGithubFileViewed,
  replyToGithubReviewThread,
  resolveGithubReviewThread,
  serializeReviewThreadMarker,
  submitGithubPullRequestReview,
  type GithubNativeReviewOctokit,
  type GithubPullRequestReviewEvent,
} from "../github/review-native.js";
import { getPublicThreadRootCommentId } from "./public-snapshot.js";
import type { DrizzleReviewStore, ReviewPullRequestRef } from "./store.js";
import type {
  AttentionPassRequest,
  CreateThreadRequest,
  MarkReviewedRequest,
  ReplyThreadRequest,
} from "./types.js";

export type ReviewActionStore = Pick<
  DrizzleReviewStore,
  | "recordCreatedThread"
  | "recordThreadReply"
  | "loadThreadGithubRef"
  | "resolveThread"
  | "markFileReviewed"
  | "passAttention"
  | "markNotMyTurn"
>;

export type ReviewActionResult =
  | {
      ok: true;
      persisted: boolean;
      githubMirrored?: boolean;
      githubResolved?: boolean;
      threadId?: string;
      warning?: string;
    }
  | { ok: false; reason: "sign-in-required" | "thread-reference-unavailable"; error: string };

/** Native review writes precede index updates; a failed index cannot undo a GitHub success. */
export function createReviewActions(input: {
  actorLogin: string;
  ref: ReviewPullRequestRef;
  store: ReviewActionStore;
  github?: GithubNativeReviewOctokit;
}) {
  const { actorLogin, ref, store, github } = input;

  return {
    // Patchset-aware marks are Clearance-owned; native viewed state is best effort.
    async markFileReviewed(request: MarkReviewedRequest): Promise<ReviewActionResult> {
      const persisted = await store.markFileReviewed(ref, actorLogin, request);
      if (github === undefined) return { ok: true, persisted, githubMirrored: false };
      try {
        const nodeId =
          request.pullRequestNodeId ?? (await findGithubPullRequestNodeId(github, ref));
        if (nodeId !== undefined) {
          await markGithubFileViewed(github, nodeId, request.filePath);
          return { ok: true, persisted, githubMirrored: true };
        }
      } catch {
        // The local mark has already committed. Do not make callers retry it.
      }
      return {
        ok: true,
        persisted,
        githubMirrored: false,
        warning: "GitHub viewed-file state could not be updated.",
      };
    },
    async passAttention(request: AttentionPassRequest): Promise<ReviewActionResult> {
      return { ok: true, persisted: await store.passAttention(ref, actorLogin, request) };
    },
    async markNotMyTurn(): Promise<ReviewActionResult> {
      return { ok: true, persisted: await store.markNotMyTurn(ref, actorLogin) };
    },
    async submitReview(request: {
      body?: string;
      event: GithubPullRequestReviewEvent;
    }): Promise<ReviewActionResult> {
      if (github === undefined) return signInRequired();
      await submitGithubPullRequestReview(github, ref, {
        event: request.event,
        body: request.body ?? (request.event === "APPROVE" ? "Reviewed in Clearance." : undefined),
      });
      return {
        ok: true,
        githubMirrored: true,
        ...(await indexNativeWrite(() => store.markNotMyTurn(ref, actorLogin))),
      };
    },
    async resolveThread(threadId: string): Promise<ReviewActionResult> {
      if (github === undefined) return signInRequired();
      const githubRef = await store.loadThreadGithubRef(ref, threadId);
      const firstCommentId = githubRef?.firstCommentId ?? getPublicThreadRootCommentId(threadId);
      const threadNodeId =
        githubRef?.threadNodeId ??
        (firstCommentId === undefined
          ? undefined
          : await findGithubReviewThreadNodeIdForComment(github, ref, firstCommentId));
      if (threadNodeId === undefined) return missingThreadReference();
      await resolveGithubReviewThread(github, threadNodeId);
      return {
        ok: true,
        githubResolved: true,
        ...(await indexNativeWrite(() => store.resolveThread(ref, actorLogin, threadId))),
      };
    },
    async replyToThread(
      threadId: string,
      request: ReplyThreadRequest,
    ): Promise<ReviewActionResult> {
      if (github === undefined) return signInRequired();
      const githubRef = await store.loadThreadGithubRef(ref, threadId);
      const firstCommentId = githubRef?.firstCommentId ?? getPublicThreadRootCommentId(threadId);
      if (firstCommentId === undefined) return missingThreadReference();
      const commentId = randomUUID();
      const marker = { commentId, threadId };
      const mirrored = await replyToGithubReviewThread(
        github,
        ref,
        firstCommentId,
        request.body,
        marker,
      );
      const indexed = await indexNativeWrite(() =>
        store.recordThreadReply(ref, actorLogin, threadId, request, {
          commentId,
          github: mirrored,
          marker: serializeReviewThreadMarker(marker),
        }),
      );
      return { ok: true, githubMirrored: true, ...indexed };
    },
    async createThread(request: CreateThreadRequest): Promise<ReviewActionResult> {
      if (github === undefined) return signInRequired();
      const threadId = randomUUID();
      const commentId = randomUUID();
      const marker = { commentId, threadId };
      const mirrored = await createGithubReviewThreadComment(github, ref, request, marker);
      const indexed = await indexNativeWrite(() =>
        store.recordCreatedThread(ref, actorLogin, request, {
          commentId,
          github: mirrored,
          marker: serializeReviewThreadMarker(marker),
          threadId,
          threadMarker: serializeReviewThreadMarker({ threadId }),
        }),
      );
      return { ok: true, githubMirrored: true, threadId, ...indexed };
    },
  };
}

function signInRequired(): ReviewActionResult {
  return {
    ok: false,
    reason: "sign-in-required",
    error: "Sign in with GitHub to change native review state.",
  };
}

function missingThreadReference(): ReviewActionResult {
  return {
    ok: false,
    reason: "thread-reference-unavailable",
    error: "The GitHub review-thread reference is unavailable. Refresh the review before retrying.",
  };
}

async function indexNativeWrite(persist: () => Promise<boolean>) {
  try {
    return { persisted: await persist() };
  } catch {
    return {
      persisted: false,
      warning:
        "Saved on GitHub, but the Clearance review index could not be updated. Refresh to reload review state.",
    };
  }
}
