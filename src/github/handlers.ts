import type { Webhooks } from "@octokit/webhooks";

import {
  listChangedFilesBetweenCommits,
  listChangedPullRequestFiles,
  listPullRequestReviewerSignals,
  loadOwnershipTree,
  enqueueGithubOutboxJob,
  githubOutboxJobTypes,
  resolveGithubIdentities,
  type CommitCompareOctokit,
  type GithubIdentityOctokit,
  type GithubStatusesOctokit,
  type GithubOutboxStore,
  type NotificationCommentOctokit,
  type OwnershipTreeOctokit,
  type PullRequestFilesOctokit,
  type ReviewerSignalsOctokit,
  type StickyCommentOctokit,
} from "./index.js";
import {
  processPullRequestChange,
  processSubmittedReview,
  type PullRequestWorkflowDependencies,
  type PullRequestWorkflowInput,
} from "../workflow/index.js";
import type { ClearanceState } from "../state/index.js";
import { parseOverrideCommentCommand } from "../override/index.js";

const pullRequestActions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export type GithubWorkflowOctokit = GithubIdentityOctokit &
  CommitCompareOctokit &
  GithubStatusesOctokit &
  NotificationCommentOctokit &
  OwnershipTreeOctokit &
  PullRequestDetailsOctokit &
  PullRequestFilesOctokit &
  ReviewerSignalsOctokit &
  StickyCommentOctokit;

type PullRequestDetailsOctokit = {
  rest: {
    pulls: {
      get(parameters: { owner: string; pull_number: number; repo: string }): Promise<{
        data: {
          head: {
            sha: string;
          };
          labels?: Array<string | { name?: string }>;
          user?: {
            login?: string;
          } | null;
        };
      }>;
    };
  };
};

export type GithubInstallationClientFactory = {
  getInstallationOctokit(installationId: number): Promise<GithubWorkflowOctokit>;
};

export type GithubHandlerStateStore = {
  beginWebhookDelivery(input: {
    action?: string;
    deliveryId: string;
    event: string;
    payload?: unknown;
  }): Promise<boolean>;
  enqueueOutboxJob: GithubOutboxStore["enqueueOutboxJob"];
  loadPullRequestState(
    input: Pick<PullRequestWorkflowInput, "owner" | "pullNumber" | "repo">,
  ): Promise<ClearanceState | undefined>;
  recordWebhookDelivery(input: {
    action?: string;
    deliveryId: string;
    error?: string;
    event: string;
    payload?: unknown;
    status: "failed" | "processed" | "processing";
  }): Promise<void>;
  savePullRequestState(input: PullRequestWorkflowInput, state: ClearanceState): Promise<void>;
};

export type GithubHandlerOptions = {
  stateStore: GithubHandlerStateStore;
};

export function registerGithubHandlers(
  webhooks: Webhooks,
  installationClientFactory: GithubInstallationClientFactory,
  options: GithubHandlerOptions,
): void {
  webhooks.on("pull_request", async ({ id, name, payload }) => {
    const shouldProcess = await beginWebhookDelivery(options, id, name, payload.action, payload);
    if (!shouldProcess) {
      return;
    }

    try {
      if (!pullRequestActions.has(payload.action)) {
        await recordWebhookDelivery(options, id, name, payload.action, payload, "processed");
        return;
      }

      const repository = payload.repository.full_name;
      const pullNumber = payload.pull_request.number;
      const installationId = getInstallationId(payload);
      const octokit = await getPayloadOctokit(payload, installationClientFactory);
      const author = payload.pull_request.user?.login;
      const sender = payload.sender?.login;

      if (
        octokit !== undefined &&
        author !== undefined &&
        sender !== undefined &&
        installationId !== undefined
      ) {
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
        const result = await processPullRequestChange(
          input,
          buildWorkflowDependencies(octokit, options, installationId),
        );

        console.info(
          {
            checks: result.checks,
            sideEffectFailures: result.sideEffectFailures,
            pullNumber,
            requestedReviewers: result.requestedReviewers,
            repository,
          },
          "processed pull request event",
        );
      }

      await recordWebhookDelivery(options, id, name, payload.action, payload, "processed");

      console.info(
        {
          action: payload.action,
          event: name,
          pullNumber,
          repository,
        },
        "received pull request event",
      );
    } catch (error) {
      await recordWebhookDelivery(
        options,
        id,
        name,
        payload.action,
        payload,
        "failed",
        getErrorMessage(error, "webhook processing failed"),
      );
      throw error;
    }
  });

  webhooks.on("pull_request_review", async ({ id, name, payload }) => {
    const shouldProcess = await beginWebhookDelivery(options, id, name, payload.action, payload);
    if (!shouldProcess) {
      return;
    }

    try {
      if (payload.action !== "submitted") {
        await recordWebhookDelivery(options, id, name, payload.action, payload, "processed");
        return;
      }

      const octokit = await getPayloadOctokit(payload, installationClientFactory);
      const installationId = getInstallationId(payload);
      const author = payload.pull_request.user?.login;
      const reviewer = payload.review.user?.login;
      const sender = payload.sender.login;
      if (
        octokit !== undefined &&
        author !== undefined &&
        reviewer !== undefined &&
        installationId !== undefined
      ) {
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
          buildWorkflowDependencies(octokit, options, installationId),
        );

        console.info(
          {
            checks: result.checks,
            sideEffectFailures: result.sideEffectFailures,
            pullNumber: payload.pull_request.number,
            repository: payload.repository.full_name,
            reviewer,
          },
          "processed pull request review event",
        );
      }

      await recordWebhookDelivery(options, id, name, payload.action, payload, "processed");

      console.info(
        {
          action: payload.action,
          pullNumber: payload.pull_request.number,
          repository: payload.repository.full_name,
          reviewState: payload.review.state,
        },
        "received pull request review event",
      );
    } catch (error) {
      await recordWebhookDelivery(
        options,
        id,
        name,
        payload.action,
        payload,
        "failed",
        getErrorMessage(error, "webhook processing failed"),
      );
      throw error;
    }
  });

  webhooks.on("issue_comment", async ({ id, name, payload }) => {
    const shouldProcess = await beginWebhookDelivery(options, id, name, payload.action, payload);
    if (!shouldProcess) {
      return;
    }

    try {
      if (payload.action !== "created") {
        await recordWebhookDelivery(options, id, name, payload.action, payload, "processed");
        return;
      }

      const command = parseOverrideCommentCommand(payload.comment.body ?? "");
      if (command === undefined || payload.issue.pull_request === undefined) {
        await recordWebhookDelivery(options, id, name, payload.action, payload, "processed");
        return;
      }

      const repository = payload.repository.full_name;
      const pullNumber = payload.issue.number;
      const installationId = getInstallationId(payload);
      const octokit = await getPayloadOctokit(payload, installationClientFactory);
      const sender = payload.sender?.login;

      if (octokit !== undefined && sender !== undefined && installationId !== undefined) {
        const pullRequest = await getPullRequestDetails(octokit, {
          owner: payload.repository.owner.login,
          pullNumber,
          repo: payload.repository.name,
        });
        const author = pullRequest.author;
        if (author !== undefined) {
          const input = await createPullRequestWorkflowInput(
            {
              author,
              headSha: pullRequest.headSha,
              labels: pullRequest.labels,
              overrideCommand: {
                ...command,
                commentId: payload.comment.id,
              },
              owner: payload.repository.owner.login,
              pullNumber,
              repo: payload.repository.name,
              sender,
            },
            payload,
            octokit,
          );
          const result = await processPullRequestChange(
            input,
            buildWorkflowDependencies(octokit, options, installationId),
          );

          console.info(
            {
              checks: result.checks,
              command: command.type,
              pullNumber,
              repository,
              sideEffectFailures: result.sideEffectFailures,
            },
            "processed override comment event",
          );
        }
      }

      await recordWebhookDelivery(options, id, name, payload.action, payload, "processed");

      console.info(
        {
          action: payload.action,
          event: name,
          pullNumber,
          repository,
        },
        "received issue comment event",
      );
    } catch (error) {
      await recordWebhookDelivery(
        options,
        id,
        name,
        payload.action,
        payload,
        "failed",
        getErrorMessage(error, "webhook processing failed"),
      );
      throw error;
    }
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

async function getPullRequestDetails(
  octokit: PullRequestDetailsOctokit,
  ref: {
    owner: string;
    pullNumber: number;
    repo: string;
  },
): Promise<{
  author?: string;
  headSha: string;
  labels: string[];
}> {
  const response = await octokit.rest.pulls.get({
    owner: ref.owner,
    pull_number: ref.pullNumber,
    repo: ref.repo,
  });

  return {
    author: response.data.user?.login,
    headSha: response.data.head.sha,
    labels: getLabelNames(response.data.labels ?? []),
  };
}

function getLabelNames(labels: Array<string | { name?: string }>): string[] {
  return labels
    .flatMap((label) => {
      if (typeof label === "string") {
        return [label];
      }

      return label.name === undefined ? [] : [label.name];
    })
    .toSorted(compareStrings);
}

function buildWorkflowDependencies(
  octokit: GithubWorkflowOctokit,
  options: GithubHandlerOptions,
  installationId: number,
): PullRequestWorkflowDependencies {
  return {
    listChangedFiles: async (input) =>
      listChangedPullRequestFiles(octokit, {
        owner: input.owner,
        pullNumber: input.pullNumber,
        repo: input.repo,
      }),
    listReviewerSignals: async (input, reviewers, changedFiles) =>
      listPullRequestReviewerSignals(octokit, {
        changedFiles,
        owner: input.owner,
        pullNumber: input.pullNumber,
        repo: input.repo,
        reviewers,
      }),
    loadState: async (input) =>
      options.stateStore.loadPullRequestState({
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
    requestReviewers: async (input, reviewers) => {
      if (reviewers.length === 0) {
        return;
      }

      await enqueueGithubOutboxJob(options.stateStore, {
        payload: {
          installationId,
          owner: input.owner,
          pullNumber: input.pullNumber,
          repo: input.repo,
          reviewers,
        },
        type: githubOutboxJobTypes.requestReviewers,
      });
    },
    resolveIdentities: async (tree) => resolveGithubIdentities(octokit, tree.files),
    saveState: async (input, state) => {
      await options.stateStore.savePullRequestState(input, state);
    },
    sendNotifications: async (input, notifications) => {
      if (notifications.length === 0) {
        return;
      }

      await enqueueGithubOutboxJob(options.stateStore, {
        payload: {
          installationId,
          notifications,
          owner: input.owner,
          pullNumber: input.pullNumber,
          repo: input.repo,
        },
        type: githubOutboxJobTypes.sendNotifications,
      });
    },
    setStatuses: async (input, decisions) => {
      if (decisions.length === 0) {
        return;
      }

      await enqueueGithubOutboxJob(options.stateStore, {
        payload: {
          decisions,
          installationId,
          owner: input.owner,
          repo: input.repo,
          sha: input.headSha,
        },
        type: githubOutboxJobTypes.setStatuses,
      });
    },
    upsertComment: async (input, body) => {
      await enqueueGithubOutboxJob(options.stateStore, {
        payload: {
          body,
          installationId,
          owner: input.owner,
          pullNumber: input.pullNumber,
          repo: input.repo,
        },
        type: githubOutboxJobTypes.upsertComment,
      });
    },
  };
}

async function beginWebhookDelivery(
  options: GithubHandlerOptions,
  deliveryId: string | undefined,
  event: string,
  action: string | undefined,
  payload: unknown,
): Promise<boolean> {
  if (deliveryId === undefined) {
    return true;
  }

  return options.stateStore.beginWebhookDelivery({
    action,
    deliveryId,
    event,
    payload,
  });
}

async function recordWebhookDelivery(
  options: GithubHandlerOptions,
  deliveryId: string | undefined,
  event: string,
  action: string | undefined,
  payload: unknown,
  status: "failed" | "processed" | "processing",
  error?: string,
): Promise<void> {
  if (deliveryId === undefined) {
    return;
  }

  await options.stateStore.recordWebhookDelivery({
    action,
    deliveryId,
    error,
    event,
    payload,
    status,
  });
}

async function getPayloadOctokit(
  payload: unknown,
  installationClientFactory: GithubInstallationClientFactory,
): Promise<GithubWorkflowOctokit | undefined> {
  const installationId = getInstallationId(payload);
  if (installationId === undefined) {
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

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
