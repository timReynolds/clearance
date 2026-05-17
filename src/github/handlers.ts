import type { Webhooks } from "@octokit/webhooks";

import {
  findStickyClearanceComment,
  listChangedFilesBetweenCommits,
  listChangedPullRequestFiles,
  loadOwnershipTree,
  requestPullRequestReviewers,
  resolveGithubIdentities,
  setCommitStatuses,
  upsertStickyClearanceComment,
  type CommitCompareOctokit,
  type GithubIdentityOctokit,
  type GithubStatusesOctokit,
  type OwnershipTreeOctokit,
  type PullRequestFilesOctokit,
  type PullRequestReviewersOctokit,
  type StickyCommentOctokit,
} from "./index.js";
import {
  processPullRequestChange,
  processSubmittedReview,
  type PullRequestWorkflowDependencies,
  type PullRequestWorkflowInput,
} from "../workflow/index.js";

const pullRequestActions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export type GithubWorkflowOctokit = GithubIdentityOctokit &
  CommitCompareOctokit &
  GithubStatusesOctokit &
  OwnershipTreeOctokit &
  PullRequestFilesOctokit &
  PullRequestReviewersOctokit &
  StickyCommentOctokit;

export type GithubInstallationClientFactory = {
  getInstallationOctokit(installationId: number): Promise<GithubWorkflowOctokit>;
};

export function registerGithubHandlers(
  webhooks: Webhooks,
  installationClientFactory?: GithubInstallationClientFactory,
): void {
  webhooks.on("pull_request", async ({ name, payload }) => {
    if (!pullRequestActions.has(payload.action)) {
      return;
    }

    const repository = payload.repository.full_name;
    const pullNumber = payload.pull_request.number;
    const octokit = await getPayloadOctokit(payload, installationClientFactory);
    const author = payload.pull_request.user?.login;
    const sender = payload.sender?.login;

    if (octokit !== undefined && author !== undefined && sender !== undefined) {
      const input = await createPullRequestWorkflowInput(
        {
          author,
          headSha: payload.pull_request.head.sha,
          labels: payload.pull_request.labels.map((label) => label.name),
          owner: payload.repository.owner.login,
          pullNumber,
          repo: payload.repository.name,
          sender,
        },
        payload,
        octokit,
      );
      const result = await processPullRequestChange(input, buildWorkflowDependencies(octokit));

      console.info(
        {
          checks: result.checks,
          pullNumber,
          requestedReviewers: result.requestedReviewers,
          repository,
        },
        "processed pull request event",
      );
    }

    console.info(
      {
        action: payload.action,
        event: name,
        pullNumber,
        repository,
      },
      "received pull request event",
    );
  });

  webhooks.on("pull_request_review", async ({ payload }) => {
    if (payload.action !== "submitted") {
      return;
    }

    const octokit = await getPayloadOctokit(payload, installationClientFactory);
    const author = payload.pull_request.user?.login;
    const reviewer = payload.review.user?.login;
    const sender = payload.sender.login;
    if (octokit !== undefined && author !== undefined && reviewer !== undefined) {
      const input = await createPullRequestWorkflowInput(
        {
          author,
          headSha: payload.pull_request.head.sha,
          labels: payload.pull_request.labels.map((label) => label.name),
          owner: payload.repository.owner.login,
          pullNumber: payload.pull_request.number,
          repo: payload.repository.name,
          sender,
        },
        payload,
        octokit,
      );
      const result = await processSubmittedReview(
        {
          ...input,
          reviewer,
          reviewState: payload.review.state,
        },
        buildWorkflowDependencies(octokit),
      );

      console.info(
        {
          checks: result.checks,
          pullNumber: payload.pull_request.number,
          repository: payload.repository.full_name,
          reviewer,
        },
        "processed pull request review event",
      );
    }

    console.info(
      {
        action: payload.action,
        pullNumber: payload.pull_request.number,
        repository: payload.repository.full_name,
        reviewState: payload.review.state,
      },
      "received pull request review event",
    );
  });

  webhooks.onError((error) => {
    console.error(error, "webhook processing failed");
  });
}

async function createPullRequestWorkflowInput(
  input: Omit<PullRequestWorkflowInput, "changedFilesSinceLastApproval" | "now">,
  payload: unknown,
  octokit: GithubWorkflowOctokit,
): Promise<PullRequestWorkflowInput> {
  const changedFilesSinceLastApproval = await getChangedFilesSinceLastApproval(
    input,
    payload,
    octokit,
  );

  return {
    ...input,
    changedFilesSinceLastApproval,
    now: new Date().toISOString(),
  };
}

async function getChangedFilesSinceLastApproval(
  input: Omit<PullRequestWorkflowInput, "changedFilesSinceLastApproval" | "now">,
  payload: unknown,
  octokit: GithubWorkflowOctokit,
): Promise<string[] | undefined> {
  const beforeSha = getSynchronizeBeforeSha(payload);
  if (beforeSha === undefined) {
    return undefined;
  }

  return listChangedFilesBetweenCommits(octokit, {
    base: beforeSha,
    head: input.headSha,
    owner: input.owner,
    repo: input.repo,
  });
}

function buildWorkflowDependencies(
  octokit: GithubWorkflowOctokit,
): PullRequestWorkflowDependencies {
  return {
    findStickyComment: async (input) =>
      findStickyClearanceComment(octokit, {
        owner: input.owner,
        pullNumber: input.pullNumber,
        repo: input.repo,
      }),
    listChangedFiles: async (input) =>
      listChangedPullRequestFiles(octokit, {
        owner: input.owner,
        pullNumber: input.pullNumber,
        repo: input.repo,
      }),
    loadOwnershipTree: async (input) =>
      loadOwnershipTree(octokit, {
        owner: input.owner,
        ref: input.headSha,
        repo: input.repo,
      }),
    requestReviewers: async (input, reviewers) =>
      requestPullRequestReviewers(
        octokit,
        {
          owner: input.owner,
          pullNumber: input.pullNumber,
          repo: input.repo,
        },
        reviewers,
      ),
    resolveIdentities: async (tree) => resolveGithubIdentities(octokit, tree.files),
    setStatuses: async (input, decisions) =>
      setCommitStatuses(
        octokit,
        {
          owner: input.owner,
          repo: input.repo,
          sha: input.headSha,
        },
        decisions,
      ),
    upsertComment: async (input, body) => {
      await upsertStickyClearanceComment(
        octokit,
        {
          owner: input.owner,
          pullNumber: input.pullNumber,
          repo: input.repo,
        },
        body,
      );
    },
  };
}

async function getPayloadOctokit(
  payload: unknown,
  installationClientFactory: GithubInstallationClientFactory | undefined,
): Promise<GithubWorkflowOctokit | undefined> {
  const installationId = getInstallationId(payload);
  if (installationClientFactory === undefined || installationId === undefined) {
    return undefined;
  }

  return installationClientFactory.getInstallationOctokit(installationId);
}

function getInstallationId(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null || !("installation" in payload)) {
    return undefined;
  }

  const installation = payload.installation;
  if (typeof installation !== "object" || installation === null || !("id" in installation)) {
    return undefined;
  }

  return typeof installation.id === "number" ? installation.id : undefined;
}

function getSynchronizeBeforeSha(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("action" in payload)) {
    return undefined;
  }

  if (payload.action !== "synchronize" || !("before" in payload)) {
    return undefined;
  }

  return typeof payload.before === "string" ? payload.before : undefined;
}
