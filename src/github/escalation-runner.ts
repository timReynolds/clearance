import { buildEscalationRequirementsFromState, processEscalationRun } from "../workflow/index.js";
import { parseClearanceState } from "../state/index.js";
import type { NotificationCommentOctokit } from "./notifications.js";
import {
  listOpenPullRequests,
  type OpenPullRequest,
  type OpenPullRequestsOctokit,
} from "./open-pull-requests.js";
import { requestPullRequestReviewers, type PullRequestReviewersOctokit } from "./reviewers.js";
import {
  findStickyClearanceComment,
  upsertStickyClearanceComment,
  type StickyCommentOctokit,
} from "./sticky-comment.js";

export type EscalationRunnerRepository = {
  owner: string;
  repo: string;
};

export type GithubEscalationRunnerOctokit = NotificationCommentOctokit &
  OpenPullRequestsOctokit &
  PullRequestReviewersOctokit &
  StickyCommentOctokit;

export type EscalationPullResult =
  | {
      actions: number;
      pullNumber: number;
      sideEffectFailures: number;
      status: "processed";
    }
  | {
      pullNumber: number;
      reason: string;
      status: "skipped";
    };

export type EscalationSweepResult = {
  pullRequests: EscalationPullResult[];
  repository: string;
};

export async function runGithubEscalationSweep(
  octokit: GithubEscalationRunnerOctokit,
  repository: EscalationRunnerRepository,
  now: string,
): Promise<EscalationSweepResult> {
  const pullRequests = await listOpenPullRequests(octokit, repository);
  const results = await Promise.all(
    pullRequests.map((pullRequest) => processPullRequest(octokit, repository, pullRequest, now)),
  );

  return {
    pullRequests: results,
    repository: `${repository.owner}/${repository.repo}`,
  };
}

async function processPullRequest(
  octokit: GithubEscalationRunnerOctokit,
  repository: EscalationRunnerRepository,
  pullRequest: OpenPullRequest,
  now: string,
): Promise<EscalationPullResult> {
  const stickyComment = await findStickyClearanceComment(octokit, {
    owner: repository.owner,
    pullNumber: pullRequest.number,
    repo: repository.repo,
  });
  if (stickyComment?.body === undefined) {
    return {
      pullNumber: pullRequest.number,
      reason: "missing sticky Clearance comment",
      status: "skipped",
    };
  }

  const parsedState = parseClearanceState(stickyComment.body);
  if (!parsedState.ok) {
    return {
      pullNumber: pullRequest.number,
      reason: parsedState.reason,
      status: "skipped",
    };
  }

  const result = await processEscalationRun(
    {
      existingCommentBody: stickyComment.body,
      now,
      requirements: buildEscalationRequirementsFromState(parsedState.state, now),
    },
    {
      postComment: async (body) => {
        await octokit.rest.issues.createComment({
          body,
          issue_number: pullRequest.number,
          owner: repository.owner,
          repo: repository.repo,
        });
      },
      requestReviewers: async (reviewers) =>
        requestPullRequestReviewers(
          octokit,
          {
            owner: repository.owner,
            pullNumber: pullRequest.number,
            repo: repository.repo,
          },
          reviewers,
        ),
      upsertComment: async (body) => {
        await upsertStickyClearanceComment(
          octokit,
          {
            owner: repository.owner,
            pullNumber: pullRequest.number,
            repo: repository.repo,
          },
          body,
        );
      },
    },
  );

  return {
    actions: result.actions.length,
    pullNumber: pullRequest.number,
    sideEffectFailures: result.sideEffectFailures.length,
    status: "processed",
  };
}
