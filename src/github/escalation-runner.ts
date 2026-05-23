import { buildEscalationRequirementsFromState, processEscalationRun } from "../workflow/index.js";
import type { ClearanceState } from "../state/index.js";
import { enqueueGithubOutboxJob, githubOutboxJobTypes, type GithubOutboxStore } from "./outbox.js";
import {
  listOpenPullRequests,
  type OpenPullRequest,
  type OpenPullRequestsOctokit,
} from "./open-pull-requests.js";

export type EscalationRunnerRepository = {
  owner: string;
  repo: string;
};

export type GithubEscalationRunnerOctokit = OpenPullRequestsOctokit;

export type GithubEscalationRunnerStateStore = {
  enqueueOutboxJob: GithubOutboxStore["enqueueOutboxJob"];
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
  installationId: number;
  stateStore: GithubEscalationRunnerStateStore;
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
  options: GithubEscalationRunnerOptions,
): Promise<EscalationSweepResult> {
  const pullRequests = await listOpenPullRequests(octokit, repository);
  const results = await Promise.all(
    pullRequests.map((pullRequest) => processPullRequest(repository, pullRequest, now, options)),
  );

  return {
    pullRequests: results,
    repository: `${repository.owner}/${repository.repo}`,
  };
}

async function processPullRequest(
  repository: EscalationRunnerRepository,
  pullRequest: OpenPullRequest,
  now: string,
  options: GithubEscalationRunnerOptions,
): Promise<EscalationPullResult> {
  const storedState = await options.stateStore.loadPullRequestState({
    owner: repository.owner,
    pullNumber: pullRequest.number,
    repo: repository.repo,
  });
  if (storedState === undefined) {
    return {
      pullNumber: pullRequest.number,
      reason: "missing stored Clearance state",
      status: "skipped",
    };
  }

  const result = await processEscalationRun(
    {
      now,
      requirements: buildEscalationRequirementsFromState(storedState, now),
      state: storedState,
    },
    {
      postComment: async (body) => {
        await enqueueGithubOutboxJob(options.stateStore, {
          payload: {
            body,
            installationId: options.installationId,
            owner: repository.owner,
            pullNumber: pullRequest.number,
            repo: repository.repo,
          },
          type: githubOutboxJobTypes.postComment,
        });
      },
      requestReviewers: async (reviewers) => {
        await enqueueGithubOutboxJob(options.stateStore, {
          payload: {
            installationId: options.installationId,
            owner: repository.owner,
            pullNumber: pullRequest.number,
            repo: repository.repo,
            reviewers,
          },
          type: githubOutboxJobTypes.requestReviewers,
        });
      },
      saveState: async (nextState) => {
        await options.stateStore.savePullRequestState(
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
        await enqueueGithubOutboxJob(options.stateStore, {
          payload: {
            body,
            installationId: options.installationId,
            owner: repository.owner,
            pullNumber: pullRequest.number,
            repo: repository.repo,
          },
          type: githubOutboxJobTypes.upsertComment,
        });
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
