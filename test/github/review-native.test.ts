import { describe, expect, it } from "vitest";

import {
  appendReviewThreadMarker,
  createGithubReviewThreadComment,
  findGithubPullRequestNodeId,
  findGithubReviewThreadNodeId,
  markGithubFileViewed,
  parseReviewThreadMarker,
  replyToGithubReviewThread,
  resolveGithubReviewThread,
  submitGithubPullRequestApproval,
} from "../../src/github/index.js";

describe("GitHub-native review helpers", () => {
  it("round-trips hidden review thread markers", () => {
    const body = appendReviewThreadMarker("Please keep this durable.", {
      commentId: "comment-1",
      threadId: "thread-1",
    });

    expect(body).toContain("Please keep this durable.");
    expect(parseReviewThreadMarker(body)).toEqual({
      commentId: "comment-1",
      threadId: "thread-1",
    });
  });

  it("ignores malformed review thread markers", () => {
    expect(parseReviewThreadMarker("plain comment")).toBeUndefined();
    expect(parseReviewThreadMarker("<!-- clearance-thread:v1\n{}\n-->")).toBeUndefined();
  });

  it("resolves GitHub review threads through GraphQL", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const graphql = async <TResponse>(query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      return { resolveReviewThread: { thread: { id: "T", isResolved: true } } } as TResponse;
    };

    await resolveGithubReviewThread({ graphql }, "T");

    expect(calls).toEqual([
      {
        query: expect.stringContaining("resolveReviewThread") as string,
        variables: { threadId: "T" },
      },
    ]);
  });

  it("marks GitHub files viewed through GraphQL", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const graphql = async <TResponse>(query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      return { markFileAsViewed: { pullRequest: { id: "PR" } } } as TResponse;
    };

    await markGithubFileViewed({ graphql }, "PR", "src/review.ts");

    expect(calls).toEqual([
      {
        query: expect.stringContaining("markFileAsViewed") as string,
        variables: {
          path: "src/review.ts",
          pullRequestId: "PR",
        },
      },
    ]);
  });

  it("creates file-level GitHub review comments with hidden markers", async () => {
    const requestCalls: Array<{ parameters: Record<string, unknown>; route: string }> = [];
    const request = async <TResponse>(route: string, parameters: Record<string, unknown>) => {
      requestCalls.push({ parameters, route });
      return {
        data: {
          html_url: "https://github.test/comment",
          id: 12,
          node_id: "COMMENT",
        },
      } as { data: TResponse };
    };
    const comment = await createGithubReviewThreadComment(
      { graphql: createReviewThreadsGraphql([{ comments: ["COMMENT"], id: "THREAD" }]), request },
      { owner: "acme", pullNumber: 5, repo: "app" },
      {
        body: "Please keep this stable.",
        commitSha: "abc123",
        filePath: "src/app.ts",
      },
      { commentId: "LOCAL_COMMENT", threadId: "LOCAL_THREAD" },
    );

    expect(comment).toEqual({
      id: 12,
      nodeId: "COMMENT",
      threadNodeId: "THREAD",
      url: "https://github.test/comment",
    });
    expect(requestCalls).toEqual([
      {
        parameters: {
          body: expect.stringContaining("clearance-thread:v1") as string,
          commit_id: "abc123",
          owner: "acme",
          path: "src/app.ts",
          pull_number: 5,
          repo: "app",
          subject_type: "file",
        },
        route: "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      },
    ]);
  });

  it("replies to GitHub review comments using the first comment id", async () => {
    const requestCalls: Array<{ parameters: Record<string, unknown>; route: string }> = [];
    const request = async <TResponse>(route: string, parameters: Record<string, unknown>) => {
      requestCalls.push({ parameters, route });
      return {
        data: {
          id: 13,
          node_id: "REPLY",
        },
      } as { data: TResponse };
    };

    await replyToGithubReviewThread(
      { request },
      { owner: "acme", pullNumber: 5, repo: "app" },
      12,
      "Fixed.",
      { commentId: "LOCAL_REPLY", threadId: "LOCAL_THREAD" },
    );

    expect(requestCalls).toEqual([
      {
        parameters: {
          body: expect.stringContaining("Fixed.") as string,
          comment_id: 12,
          owner: "acme",
          pull_number: 5,
          repo: "app",
        },
        route: "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
      },
    ]);
  });

  it("submits approval reviews through GitHub", async () => {
    const requestCalls: Array<{ parameters: Record<string, unknown>; route: string }> = [];
    const request = async <TResponse>(route: string, parameters: Record<string, unknown>) => {
      requestCalls.push({ parameters, route });
      return { data: {} as TResponse };
    };

    await submitGithubPullRequestApproval(
      { request },
      { owner: "acme", pullNumber: 5, repo: "app" },
      "Reviewed in Clearance.",
    );

    expect(requestCalls).toEqual([
      {
        parameters: {
          body: "Reviewed in Clearance.",
          event: "APPROVE",
          owner: "acme",
          pull_number: 5,
          repo: "app",
        },
        route: "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      },
    ]);
  });

  it("finds GitHub review thread node ids from comment node ids", async () => {
    await expect(
      findGithubReviewThreadNodeId(
        {
          graphql: createReviewThreadsGraphql([
            { comments: ["OTHER"], id: "THREAD_OTHER" },
            { comments: ["COMMENT"], id: "THREAD" },
          ]),
        },
        { owner: "acme", pullNumber: 5, repo: "app" },
        "COMMENT",
      ),
    ).resolves.toBe("THREAD");
  });

  it("paginates GitHub review threads and thread comments when finding node ids", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const graphql = async <TResponse>(_query: string, variables: Record<string, unknown>) => {
      calls.push(variables);
      if (variables.threadNodeId === "THREAD_OTHER") {
        return {
          node: {
            comments: {
              nodes: [{ id: "STILL_OTHER" }],
              pageInfo: { hasNextPage: false },
            },
          },
        } as TResponse;
      }

      if (variables.threadCursor === undefined) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    comments: {
                      nodes: [{ id: "OTHER" }],
                      pageInfo: { endCursor: "comment-page-1", hasNextPage: true },
                    },
                    id: "THREAD_OTHER",
                  },
                ],
                pageInfo: { endCursor: "thread-page-1", hasNextPage: true },
              },
            },
          },
        } as TResponse;
      }

      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  comments: {
                    nodes: [{ id: "COMMENT" }],
                    pageInfo: { hasNextPage: false },
                  },
                  id: "THREAD",
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      } as TResponse;
    };

    await expect(
      findGithubReviewThreadNodeId(
        { graphql },
        { owner: "acme", pullNumber: 5, repo: "app" },
        "COMMENT",
      ),
    ).resolves.toBe("THREAD");
    expect(calls).toEqual([
      { number: 5, owner: "acme", repo: "app", threadCursor: undefined },
      { commentCursor: "comment-page-1", threadNodeId: "THREAD_OTHER" },
      { number: 5, owner: "acme", repo: "app", threadCursor: "thread-page-1" },
    ]);
  });

  it("finds GitHub pull request node ids for viewed-file mirroring", async () => {
    await expect(
      findGithubPullRequestNodeId(
        { graphql: createPullRequestNodeGraphql("PR_NODE") },
        { owner: "acme", pullNumber: 5, repo: "app" },
      ),
    ).resolves.toBe("PR_NODE");
  });
});

function createReviewThreadsGraphql(
  threads: Array<{ comments: string[]; id: string }>,
): <TResponse>() => Promise<TResponse> {
  return async <TResponse>() =>
    ({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: threads.map((thread) => ({
              comments: {
                nodes: thread.comments.map((id) => ({ id })),
                pageInfo: { hasNextPage: false },
              },
              id: thread.id,
            })),
          },
        },
      },
    }) as TResponse;
}

function createPullRequestNodeGraphql(nodeId: string): <TResponse>() => Promise<TResponse> {
  return async <TResponse>() =>
    ({
      repository: {
        pullRequest: {
          id: nodeId,
        },
      },
    }) as TResponse;
}
