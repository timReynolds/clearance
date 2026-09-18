import { describe, expect, it, vi } from "vitest";

import { createReviewActions, type ReviewActionStore } from "../../src/review/actions.js";
import {
  type GithubNativeReviewOctokit,
  parseReviewThreadMarker,
} from "../../src/github/review-native.js";

const ref = { owner: "acme", repo: "widget", pullNumber: 17 };
const thread = {
  body: "Please simplify this.",
  commitSha: "head",
  filePath: "src/index.ts",
  line: 12,
};

function setup() {
  const store = {
    recordCreatedThread: vi.fn<ReviewActionStore["recordCreatedThread"]>().mockResolvedValue(true),
    recordThreadReply: vi.fn<ReviewActionStore["recordThreadReply"]>().mockResolvedValue(true),
    loadThreadGithubRef: vi
      .fn<ReviewActionStore["loadThreadGithubRef"]>()
      .mockResolvedValue(undefined),
    resolveThread: vi.fn<ReviewActionStore["resolveThread"]>().mockResolvedValue(true),
    markFileReviewed: vi.fn<ReviewActionStore["markFileReviewed"]>().mockResolvedValue(true),
    passAttention: vi.fn<ReviewActionStore["passAttention"]>().mockResolvedValue(true),
    markNotMyTurn: vi.fn<ReviewActionStore["markNotMyTurn"]>().mockResolvedValue(true),
  };
  const request = vi
    .fn<GithubNativeReviewOctokit["request"]>()
    .mockResolvedValue({ data: { id: 42, html_url: "https://github.com/comment/42" } });
  const graphql = vi.fn<GithubNativeReviewOctokit["graphql"]>().mockResolvedValue({});
  const github: GithubNativeReviewOctokit = {
    request: request as GithubNativeReviewOctokit["request"],
    graphql: graphql as GithubNativeReviewOctokit["graphql"],
  };
  return {
    actions: createReviewActions({ actorLogin: "alice", ref, store, github }),
    store,
    request,
    graphql,
  };
}

describe("review actions", () => {
  it("reports a successful GitHub comment when updating the review index fails", async () => {
    const { actions, store, request } = setup();
    store.recordCreatedThread.mockRejectedValue(new Error("database unavailable"));

    const result = await actions.createThread(thread);

    expect(result).toMatchObject({
      ok: true,
      githubMirrored: true,
      persisted: false,
      warning: expect.stringContaining("GitHub"),
    });
    const marker = parseReviewThreadMarker(String(request.mock.calls[0]?.[1].body));
    expect(marker?.threadId).toBe(result.ok ? result.threadId : undefined);
    expect(marker?.commentId).toEqual(expect.any(String));
    expect(store.recordCreatedThread).toHaveBeenCalledWith(
      ref,
      "alice",
      thread,
      expect.objectContaining({
        threadId: marker?.threadId,
        commentId: marker?.commentId,
        github: expect.objectContaining({ id: 42 }),
      }),
    );
  });
});

it("does not record a local reply when the GitHub root comment is unknown", async () => {
  const { actions, store, request } = setup();
  expect(await actions.replyToThread("missing-thread", { body: "Reply" })).toMatchObject({
    ok: false,
    reason: "thread-reference-unavailable",
  });
  expect(request).not.toHaveBeenCalled();
  expect(store.recordThreadReply).not.toHaveBeenCalled();
});

it("finds the GitHub thread through an indexed root comment before resolving locally", async () => {
  const { actions, store, request, graphql } = setup();
  store.loadThreadGithubRef.mockResolvedValue({ firstCommentId: 42 });
  request.mockResolvedValue({ data: { node_id: "COMMENT_42" } });
  graphql
    .mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: "THREAD_42",
                comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: "COMMENT_42" }] },
              },
            ],
          },
        },
      },
    })
    .mockResolvedValueOnce({});
  store.resolveThread.mockImplementation(async () => {
    expect(graphql).toHaveBeenLastCalledWith(expect.stringContaining("resolveReviewThread"), {
      threadId: "THREAD_42",
    });
    return true;
  });
  expect(await actions.resolveThread("indexed-thread")).toMatchObject({
    ok: true,
    githubResolved: true,
    persisted: true,
  });
});

it("preserves a submitted review when clearing attention fails", async () => {
  const { actions, store, request } = setup();
  store.markNotMyTurn.mockImplementation(async () => {
    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: "acme",
      repo: "widget",
      pull_number: 17,
      event: "APPROVE",
      body: "Reviewed in Clearance.",
    });
    throw new Error("attention update failed");
  });
  expect(await actions.submitReview({ event: "APPROVE" })).toMatchObject({
    ok: true,
    githubMirrored: true,
    persisted: false,
    warning: expect.any(String),
  });
});

it("keeps the patchset-aware mark when GitHub viewed-file mirroring fails", async () => {
  const { actions, store, graphql } = setup();
  graphql.mockImplementation(async () => {
    expect(store.markFileReviewed).toHaveBeenCalledWith(ref, "alice", {
      filePath: "src/index.ts",
      patchsetNumber: 2,
    });
    throw new Error("GitHub unavailable");
  });
  expect(
    await actions.markFileReviewed({ filePath: "src/index.ts", patchsetNumber: 2 }),
  ).toMatchObject({
    ok: true,
    persisted: true,
    githubMirrored: false,
    warning: expect.any(String),
  });
});

it("still indexes an accepted comment when GitHub thread discovery fails", async () => {
  const { actions, store, request, graphql } = setup();
  request.mockResolvedValue({ data: { id: 42, node_id: "COMMENT_42" } });
  graphql.mockRejectedValue(new Error("GitHub read failed after write"));
  expect(await actions.createThread(thread)).toMatchObject({
    ok: true,
    githubMirrored: true,
    persisted: true,
  });
  expect(store.recordCreatedThread).toHaveBeenCalledWith(
    ref,
    "alice",
    thread,
    expect.objectContaining({
      github: expect.objectContaining({ id: 42, nodeId: "COMMENT_42", threadNodeId: undefined }),
    }),
  );
});

it("does not resolve the index when an imported thread has no recoverable GitHub reference", async () => {
  const { actions, store, graphql } = setup();
  expect(await actions.resolveThread("missing-thread")).toMatchObject({
    ok: false,
    reason: "thread-reference-unavailable",
  });
  expect(graphql).not.toHaveBeenCalled();
  expect(store.resolveThread).not.toHaveBeenCalled();
});

it("replies to a public GitHub thread without requiring it in the index", async () => {
  const { actions, store, request } = setup();
  store.recordThreadReply.mockResolvedValue(false);
  expect(await actions.replyToThread("github-comment-42", { body: "Reply" })).toMatchObject({
    ok: true,
    githubMirrored: true,
    persisted: false,
  });
  expect(request).toHaveBeenCalledWith(
    expect.stringContaining("/replies"),
    expect.objectContaining({ comment_id: 42 }),
  );
});

it("leaves attention unchanged when GitHub rejects a submitted review", async () => {
  const { actions, store, request } = setup();
  request.mockRejectedValue(new Error("review rejected"));
  await expect(
    actions.submitReview({ event: "REQUEST_CHANGES", body: "Please fix this." }),
  ).rejects.toThrow("review rejected");
  expect(store.markNotMyTurn).not.toHaveBeenCalled();
});

it("does not record a native comment locally without a signed-in GitHub adapter", async () => {
  const { store } = setup();
  const actions = createReviewActions({ actorLogin: "alice", ref, store });
  expect(await actions.createThread(thread)).toMatchObject({
    ok: false,
    reason: "sign-in-required",
  });
  expect(store.recordCreatedThread).not.toHaveBeenCalled();
});

it("does not index a comment rejected by GitHub", async () => {
  const { actions, store, request } = setup();
  request.mockRejectedValue(new Error("invalid diff line"));
  await expect(actions.createThread(thread)).rejects.toThrow("invalid diff line");
  expect(store.recordCreatedThread).not.toHaveBeenCalled();
});

it("mirrors a reviewed file after its local mark is persisted", async () => {
  const { actions, store, graphql } = setup();
  graphql
    .mockResolvedValueOnce({ repository: { pullRequest: { id: "PR_17" } } })
    .mockImplementationOnce(async <TResponse>() => {
      expect(store.markFileReviewed).toHaveBeenCalled();
      return {} as TResponse;
    });
  expect(
    await actions.markFileReviewed({ filePath: "src/index.ts", patchsetNumber: 2 }),
  ).toMatchObject({ ok: true, persisted: true, githubMirrored: true });
  expect(graphql).toHaveBeenLastCalledWith(expect.stringContaining("markFileAsViewed"), {
    path: "src/index.ts",
    pullRequestId: "PR_17",
  });
});

it("reports an accepted GitHub resolution even when the index write fails", async () => {
  const { actions, store } = setup();
  store.loadThreadGithubRef.mockResolvedValue({ threadNodeId: "THREAD_42" });
  store.resolveThread.mockRejectedValue(new Error("index unavailable"));
  expect(await actions.resolveThread("thread-42")).toMatchObject({
    ok: true,
    githubResolved: true,
    persisted: false,
    warning: expect.any(String),
  });
});

it("passes and clears Clearance-owned attention through the review index", async () => {
  const { actions, store, request, graphql } = setup();
  expect(await actions.passAttention({ targetLogin: "bob" })).toEqual({
    ok: true,
    persisted: true,
  });
  expect(await actions.markNotMyTurn()).toEqual({ ok: true, persisted: true });
  expect(store.passAttention).toHaveBeenCalledWith(ref, "alice", { targetLogin: "bob" });
  expect(store.markNotMyTurn).toHaveBeenCalledWith(ref, "alice");
  expect(request).not.toHaveBeenCalled();
  expect(graphql).not.toHaveBeenCalled();
});
