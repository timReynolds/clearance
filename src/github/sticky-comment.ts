import { clearanceStateBlockStart } from "../state/index.js";

export type PullRequestRef = {
  owner: string;
  pullNumber: number;
  repo: string;
};

export type StickyCommentOctokit = {
  rest: {
    issues: {
      createComment(parameters: {
        body: string;
        issue_number: number;
        owner: string;
        repo: string;
      }): Promise<{
        data: {
          id: number;
          body?: string;
        };
      }>;
      listComments(parameters: {
        issue_number: number;
        owner: string;
        page?: number;
        per_page?: number;
        repo: string;
      }): Promise<{
        data: Array<{
          body?: string;
          id: number;
        }>;
      }>;
      updateComment(parameters: {
        body: string;
        comment_id: number;
        owner: string;
        repo: string;
      }): Promise<{
        data: {
          id: number;
          body?: string;
        };
      }>;
    };
  };
};

export type StickyCommentResult =
  | {
      commentId: number;
      created: false;
      updated: true;
    }
  | {
      commentId: number;
      created: true;
      updated: false;
    };

export type StickyClearanceComment = {
  body?: string;
  id: number;
};

export async function upsertStickyClearanceComment(
  octokit: StickyCommentOctokit,
  pullRequest: PullRequestRef,
  body: string,
): Promise<StickyCommentResult> {
  const existingComment = await findStickyClearanceComment(octokit, pullRequest);
  if (existingComment !== undefined) {
    const response = await octokit.rest.issues.updateComment({
      body,
      comment_id: existingComment.id,
      owner: pullRequest.owner,
      repo: pullRequest.repo,
    });

    return {
      commentId: response.data.id,
      created: false,
      updated: true,
    };
  }

  const response = await octokit.rest.issues.createComment({
    body,
    issue_number: pullRequest.pullNumber,
    owner: pullRequest.owner,
    repo: pullRequest.repo,
  });

  return {
    commentId: response.data.id,
    created: true,
    updated: false,
  };
}

export async function findStickyClearanceComment(
  octokit: StickyCommentOctokit,
  pullRequest: PullRequestRef,
  page = 1,
): Promise<StickyClearanceComment | undefined> {
  const response = await octokit.rest.issues.listComments({
    issue_number: pullRequest.pullNumber,
    owner: pullRequest.owner,
    page,
    per_page: 100,
    repo: pullRequest.repo,
  });
  const match = response.data.find((comment) => comment.body?.includes(clearanceStateBlockStart));

  if (match !== undefined) {
    return {
      body: match.body,
      id: match.id,
    };
  }

  if (response.data.length < 100) {
    return undefined;
  }

  return findStickyClearanceComment(octokit, pullRequest, page + 1);
}
