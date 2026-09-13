import { buildEscalationRequirementsFromState, processEscalationRun } from "../workflow/index.js";
import type { ClearanceState } from "../state/index.js";
import {
  commitGithubReviewTransition,
  type GithubReviewTransitionStore,
} from "./review-transition.js";
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

export type GithubEscalationRunnerStateStore = GithubReviewTransitionStore & {
  loadPullRequestState(input: {
    owner: string;
    pullNumber: number;
    repo: string;
  }): Promise<ClearanceState | undefined>;
};

export type GithubEscalationRunnerOptions = {
  installationId: number;
  stateStore: GithubEscalationRunnerStateStore;
};

export type EscalationPullResult =
  | {
      actions: number;
      pullNumber: number;
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
      commitTransition: (transition) =>
        commitGithubReviewTransition(
          options.stateStore,
          {
            author: pullRequest.author,
            headSha: pullRequest.headSha,
            labels: pullRequest.labels,
            now,
            owner: repository.owner,
            pullNumber: pullRequest.number,
            repo: repository.repo,
          },
          options.installationId,
          transition,
        ),
    },
  );

  return {
    actions: result.actions.length,
    pullNumber: pullRequest.number,
    status: "processed",
  };
}
