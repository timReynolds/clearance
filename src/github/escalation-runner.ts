import { buildEscalationRequirementsFromState, processEscalationRun } from "../workflow/index.js";
import { parseClearanceState, type ClearanceState } from "../state/index.js";
import type { NotificationCommentOctokit } from "./notifications.js";
import { enqueueGithubOutboxJob, githubOutboxJobTypes, type GithubOutboxStore } from "./outbox.js";
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

export type GithubEscalationRunnerStateStore = {
  enqueueOutboxJob?: GithubOutboxStore["enqueueOutboxJob"];
  loadPullRequestState(input: {
    owner: string;
    pullNumber: number;
    repo: string;
  }): Promise<ClearanceState | undefined>;
  savePullRequestState(
    input: {
      author: string;
      headSha: string;
      labels: string[];
      now: string;
      owner: string;
      pullNumber: number;
      repo: string;
    },
    state: ClearanceState,
  ): Promise<void>;
};

export type GithubEscalationRunnerOptions = {
  installationId?: number;
  stateStore?: GithubEscalationRunnerStateStore;
};

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
  options: GithubEscalationRunnerOptions = {},
): Promise<EscalationSweepResult> {
  const pullRequests = await listOpenPullRequests(octokit, repository);
  const results = await Promise.all(
    pullRequests.map((pullRequest) =>
      processPullRequest(octokit, repository, pullRequest, now, options),
    ),
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
  options: GithubEscalationRunnerOptions,
): Promise<EscalationPullResult> {
  const outbox = getGithubOutbox(options);
  const stickyComment = await findStickyClearanceComment(octokit, {
    owner: repository.owner,
    pullNumber: pullRequest.number,
    repo: repository.repo,
  });
  const storedState = await options.stateStore?.loadPullRequestState({
    owner: repository.owner,
    pullNumber: pullRequest.number,
    repo: repository.repo,
  });
  if (stickyComment?.body === undefined && storedState === undefined) {
    return {
      pullNumber: pullRequest.number,
      reason:
        options.stateStore === undefined
          ? "missing sticky Clearance comment"
          : "missing sticky Clearance comment and stored Clearance state",
      status: "skipped",
    };
  }

  const parsedState =
    storedState === undefined ? parseClearanceState(stickyComment?.body) : undefined;
  if (storedState === undefined && parsedState?.ok === false) {
    return {
      pullNumber: pullRequest.number,
      reason: parsedState.reason,
      status: "skipped",
    };
  }
  const state = storedState ?? parsedState?.state;
  if (state === undefined) {
    return {
      pullNumber: pullRequest.number,
      reason: "missing Clearance state",
      status: "skipped",
    };
  }

  const result = await processEscalationRun(
    {
      existingCommentBody: stickyComment?.body,
      existingState: state,
      now,
      requirements: buildEscalationRequirementsFromState(state, now),
    },
    {
      postComment: async (body) => {
        if (outbox !== undefined) {
          await enqueueGithubOutboxJob(outbox.store, {
            payload: {
              body,
              installationId: outbox.installationId,
              owner: repository.owner,
              pullNumber: pullRequest.number,
              repo: repository.repo,
            },
            type: githubOutboxJobTypes.postComment,
          });
          return;
        }

        await octokit.rest.issues.createComment({
          body,
          issue_number: pullRequest.number,
          owner: repository.owner,
          repo: repository.repo,
        });
      },
      requestReviewers: async (reviewers) =>
        outbox === undefined
          ? requestPullRequestReviewers(
              octokit,
              {
                owner: repository.owner,
                pullNumber: pullRequest.number,
                repo: repository.repo,
              },
              reviewers,
            )
          : enqueueGithubOutboxJob(outbox.store, {
              payload: {
                installationId: outbox.installationId,
                owner: repository.owner,
                pullNumber: pullRequest.number,
                repo: repository.repo,
                reviewers,
              },
              type: githubOutboxJobTypes.requestReviewers,
            }),
      saveState: async (nextState) => {
        await options.stateStore?.savePullRequestState(
          {
            author: pullRequest.author,
            headSha: pullRequest.headSha,
            labels: pullRequest.labels,
            now,
            owner: repository.owner,
            pullNumber: pullRequest.number,
            repo: repository.repo,
          },
          nextState,
        );
      },
      upsertComment: async (body) => {
        if (outbox !== undefined) {
          await enqueueGithubOutboxJob(outbox.store, {
            payload: {
              body,
              installationId: outbox.installationId,
              owner: repository.owner,
              pullNumber: pullRequest.number,
              repo: repository.repo,
            },
            type: githubOutboxJobTypes.upsertComment,
          });
          return;
        }

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

function getGithubOutbox(
  options: GithubEscalationRunnerOptions,
): { installationId: number; store: GithubOutboxStore } | undefined {
  if (options.installationId === undefined || options.stateStore?.enqueueOutboxJob === undefined) {
    return undefined;
  }

  return {
    installationId: options.installationId,
    store: {
      enqueueOutboxJob: options.stateStore.enqueueOutboxJob,
    },
  };
}
