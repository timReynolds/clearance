export const reviewThreadMarkerStart = "<!-- clearance-thread:v1";
export const reviewThreadMarkerEnd = "-->";

export type ReviewThreadMarker = {
  commentId?: string;
  threadId: string;
};

export type GithubNativeReviewOctokit = {
  graphql<TResponse>(query: string, variables: Record<string, unknown>): Promise<TResponse>;
  request<TResponse>(
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<{ data: TResponse }>;
};

export type GithubReviewPullRequestRef = {
  owner: string;
  pullNumber: number;
  repo: string;
};

export type CreateGithubReviewThreadInput = {
  body: string;
  commitSha: string;
  filePath: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
};

export type GithubReviewCommentMirror = {
  id: number;
  nodeId?: string;
  threadNodeId?: string;
  url?: string;
};

export function appendReviewThreadMarker(body: string, marker: ReviewThreadMarker): string {
  return `${body.trim()}\n\n${serializeReviewThreadMarker(marker)}\n`;
}

export function serializeReviewThreadMarker(marker: ReviewThreadMarker): string {
  return `${reviewThreadMarkerStart}\n${JSON.stringify(marker, null, 2)}\n${reviewThreadMarkerEnd}`;
}

export function parseReviewThreadMarker(body: string | undefined): ReviewThreadMarker | undefined {
  if (body === undefined) {
    return undefined;
  }

  const start = body.indexOf(reviewThreadMarkerStart);
  if (start === -1) {
    return undefined;
  }

  const jsonStart = start + reviewThreadMarkerStart.length;
  const end = body.indexOf(reviewThreadMarkerEnd, jsonStart);
  if (end === -1) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body.slice(jsonStart, end).trim());
    if (!isReviewThreadMarker(parsed)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

export function stripReviewThreadMarker(body: string): string {
  const start = body.indexOf(reviewThreadMarkerStart);
  if (start === -1) {
    return body;
  }

  return body.slice(0, start).trim();
}

export async function resolveGithubReviewThread(
  octokit: Pick<GithubNativeReviewOctokit, "graphql">,
  threadNodeId: string,
): Promise<void> {
  await octokit.graphql(
    `mutation ResolveClearanceReviewThread($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread {
          id
          isResolved
        }
      }
    }`,
    { threadId: threadNodeId },
  );
}

export async function createGithubReviewThreadComment(
  octokit: Pick<GithubNativeReviewOctokit, "graphql" | "request">,
  ref: GithubReviewPullRequestRef,
  input: CreateGithubReviewThreadInput,
  marker: ReviewThreadMarker,
): Promise<GithubReviewCommentMirror> {
  const parameters: Record<string, unknown> = {
    body: appendReviewThreadMarker(input.body, marker),
    commit_id: input.commitSha,
    owner: ref.owner,
    path: input.filePath,
    pull_number: ref.pullNumber,
    repo: ref.repo,
  };

  if (input.line === undefined) {
    parameters.subject_type = "file";
  } else {
    parameters.line = input.line;
    parameters.side = input.side ?? "RIGHT";
  }

  const response = await octokit.request<GithubReviewCommentResponse>(
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
    parameters,
  );
  const threadNodeId =
    response.data.node_id === undefined
      ? undefined
      : await findGithubReviewThreadNodeId(octokit, ref, response.data.node_id);

  return {
    id: response.data.id,
    nodeId: response.data.node_id,
    threadNodeId,
    url: response.data.html_url,
  };
}

export async function replyToGithubReviewThread(
  octokit: Pick<GithubNativeReviewOctokit, "request">,
  ref: GithubReviewPullRequestRef,
  commentId: number,
  body: string,
  marker: ReviewThreadMarker,
): Promise<GithubReviewCommentMirror> {
  const response = await octokit.request<GithubReviewCommentResponse>(
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
    {
      body: appendReviewThreadMarker(body, marker),
      comment_id: commentId,
      owner: ref.owner,
      pull_number: ref.pullNumber,
      repo: ref.repo,
    },
  );

  return {
    id: response.data.id,
    nodeId: response.data.node_id,
    url: response.data.html_url,
  };
}

export async function submitGithubPullRequestApproval(
  octokit: Pick<GithubNativeReviewOctokit, "request">,
  ref: GithubReviewPullRequestRef,
  body: string | undefined,
): Promise<void> {
  await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    body,
    event: "APPROVE",
    owner: ref.owner,
    pull_number: ref.pullNumber,
    repo: ref.repo,
  });
}

export async function markGithubFileViewed(
  octokit: Pick<GithubNativeReviewOctokit, "graphql">,
  pullRequestNodeId: string,
  path: string,
): Promise<void> {
  await octokit.graphql(
    `mutation MarkClearanceReviewFileViewed($pullRequestId: ID!, $path: String!) {
      markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
        pullRequest {
          id
        }
      }
    }`,
    { path, pullRequestId: pullRequestNodeId },
  );
}

export async function findGithubPullRequestNodeId(
  octokit: Pick<GithubNativeReviewOctokit, "graphql">,
  ref: GithubReviewPullRequestRef,
): Promise<string | undefined> {
  const response = await octokit.graphql<PullRequestNodeQueryResponse>(
    `query FindClearancePullRequestNode($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
        }
      }
    }`,
    { number: ref.pullNumber, owner: ref.owner, repo: ref.repo },
  );

  return response.repository?.pullRequest?.id;
}

export async function findGithubReviewThreadNodeId(
  octokit: Pick<GithubNativeReviewOctokit, "graphql">,
  ref: GithubReviewPullRequestRef,
  commentNodeId: string,
): Promise<string | undefined> {
  return findGithubReviewThreadNodeIdPage(octokit, ref, commentNodeId);
}

async function findGithubReviewThreadNodeIdPage(
  octokit: Pick<GithubNativeReviewOctokit, "graphql">,
  ref: GithubReviewPullRequestRef,
  commentNodeId: string,
  threadCursor?: string,
): Promise<string | undefined> {
  const response = await octokit.graphql<ReviewThreadsQueryResponse>(
    `query FindClearanceReviewThread(
        $owner: String!
        $repo: String!
        $number: Int!
        $threadCursor: String
      ) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $threadCursor) {
            pageInfo {
              endCursor
              hasNextPage
            }
            nodes {
              id
              comments(first: 100) {
                pageInfo {
                  endCursor
                  hasNextPage
                }
                nodes {
                  id
                }
              }
            }
          }
        }
      }
    }`,
    { number: ref.pullNumber, owner: ref.owner, repo: ref.repo, threadCursor },
  );

  const reviewThreads = response.repository?.pullRequest?.reviewThreads;
  const threads = reviewThreads?.nodes ?? [];
  const threadWithFirstPageMatch = threads.find((thread) =>
    thread.comments.nodes.some((comment) => comment.id === commentNodeId),
  );
  if (threadWithFirstPageMatch !== undefined) {
    return threadWithFirstPageMatch.id;
  }

  const threadCommentMatches = await Promise.all(
    threads
      .filter((thread) => getNextCursor(thread.comments.pageInfo) !== undefined)
      .map(async (thread) => {
        const containsComment = await reviewThreadContainsComment(
          octokit,
          thread.id,
          commentNodeId,
          getNextCursor(thread.comments.pageInfo),
        );
        return containsComment ? thread.id : undefined;
      }),
  );
  const threadWithPagedCommentMatch = threadCommentMatches.find(isString);
  if (threadWithPagedCommentMatch !== undefined) {
    return threadWithPagedCommentMatch;
  }

  const nextThreadCursor =
    reviewThreads === undefined ? undefined : getNextCursor(reviewThreads.pageInfo);
  if (nextThreadCursor !== undefined) {
    return findGithubReviewThreadNodeIdPage(octokit, ref, commentNodeId, nextThreadCursor);
  }

  return undefined;
}

async function reviewThreadContainsComment(
  octokit: Pick<GithubNativeReviewOctokit, "graphql">,
  threadNodeId: string,
  commentNodeId: string,
  commentCursor: string | undefined,
): Promise<boolean> {
  const response = await octokit.graphql<ReviewThreadCommentsQueryResponse>(
    `query FindClearanceReviewThreadComment($threadNodeId: ID!, $commentCursor: String) {
        node(id: $threadNodeId) {
          ... on PullRequestReviewThread {
            comments(first: 100, after: $commentCursor) {
              pageInfo {
                endCursor
                hasNextPage
              }
              nodes {
                id
              }
            }
          }
        }
      }`,
    { commentCursor, threadNodeId },
  );
  const comments = response.node?.comments;
  if (comments?.nodes.some((comment) => comment.id === commentNodeId) === true) {
    return true;
  }

  const nextCommentCursor = comments === undefined ? undefined : getNextCursor(comments.pageInfo);
  if (nextCommentCursor !== undefined) {
    return reviewThreadContainsComment(octokit, threadNodeId, commentNodeId, nextCommentCursor);
  }

  return false;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function getNextCursor(pageInfo: PageInfo): string | undefined {
  return pageInfo.hasNextPage && typeof pageInfo.endCursor === "string"
    ? pageInfo.endCursor
    : undefined;
}

function isReviewThreadMarker(value: unknown): value is ReviewThreadMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.threadId === "string" &&
    (record.commentId === undefined || typeof record.commentId === "string")
  );
}

type GithubReviewCommentResponse = {
  html_url?: string;
  id: number;
  node_id?: string;
};

type ReviewThreadsQueryResponse = {
  repository?: {
    pullRequest?: {
      reviewThreads: {
        pageInfo: PageInfo;
        nodes: Array<{
          comments: {
            pageInfo: PageInfo;
            nodes: Array<{ id: string }>;
          };
          id: string;
        }>;
      };
    };
  };
};

type PullRequestNodeQueryResponse = {
  repository?: {
    pullRequest?: {
      id: string;
    };
  };
};

type ReviewThreadCommentsQueryResponse = {
  node?: {
    comments: {
      pageInfo: PageInfo;
      nodes: Array<{ id: string }>;
    };
  };
};

type PageInfo = {
  endCursor?: string | null;
  hasNextPage: boolean;
};
