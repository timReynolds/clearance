import type { Webhooks } from "@octokit/webhooks";

import {
  findStickyClearanceComment,
  listChangedFilesBetweenCommits,
  listChangedPullRequestFiles,
  listPullRequestReviewerSignals,
  loadOwnershipTree,
  enqueueGithubOutboxJob,
  githubOutboxJobTypes,
  requestPullRequestReviewers,
  resolveGithubIdentities,
  sendPullRequestNotifications,
  setCommitStatuses,
  upsertStickyClearanceComment,
  type CommitCompareOctokit,
  type GithubIdentityOctokit,
  type GithubStatusesOctokit,
  type GithubOutboxStore,
  type NotificationCommentOctokit,
  type OwnershipTreeOctokit,
  type PullRequestFilesOctokit,
  type PullRequestReviewersOctokit,
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

const pullRequestActions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export type GithubWorkflowOctokit = GithubIdentityOctokit &
  CommitCompareOctokit &
  GithubStatusesOctokit &
  NotificationCommentOctokit &
  OwnershipTreeOctokit &
  PullRequestFilesOctokit &
  PullRequestReviewersOctokit &
  ReviewerSignalsOctokit &
  StickyCommentOctokit;

export type GithubInstallationClientFactory = {
  getInstallationOctokit(installationId: number): Promise<GithubWorkflowOctokit>;
};

export type GithubHandlerStateStore = {
  beginWebhookDelivery?(input: {
    action?: string;
    deliveryId: string;
    event: string;
    payload?: unknown;
  }): Promise<boolean>;
  enqueueOutboxJob?: GithubOutboxStore["enqueueOutboxJob"];
  loadPullRequestState(
    input: Pick<PullRequestWorkflowInput, "owner" | "pullNumber" | "repo">,
  ): Promise<ClearanceState | undefined>;
  recordWebhookDelivery?(input: {
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
  stateStore?: GithubHandlerStateStore;
};

export function registerGithubHandlers(
  webhooks: Webhooks,
  installationClientFactory?: GithubInstallationClientFactory,
  options: GithubHandlerOptions = {},
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
  options: GithubHandlerOptions,
  installationId: number | undefined,
): PullRequestWorkflowDependencies {
  const outbox = getGithubOutbox(options, installationId);

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
    listReviewerSignals: async (input, reviewers, changedFiles) =>
      listPullRequestReviewerSignals(octokit, {
        changedFiles,
        owner: input.owner,
        pullNumber: input.pullNumber,
        repo: input.repo,
        reviewers,
      }),
    loadState: async (input) =>
      options.stateStore?.loadPullRequestState({
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
      if (outbox !== undefined && reviewers.length > 0) {
        await enqueueGithubOutboxJob(outbox.store, {
          payload: {
            installationId: outbox.installationId,
            owner: input.owner,
            pullNumber: input.pullNumber,
            repo: input.repo,
            reviewers,
          },
          type: githubOutboxJobTypes.requestReviewers,
        });
        return;
      }

      await requestPullRequestReviewers(
        octokit,
        {
          owner: input.owner,
          pullNumber: input.pullNumber,
          repo: input.repo,
        },
        reviewers,
      );
    },
    resolveIdentities: async (tree) => resolveGithubIdentities(octokit, tree.files),
    saveState: async (input, state) => {
      await options.stateStore?.savePullRequestState(input, state);
    },
    sendNotifications: async (input, notifications) => {
      if (outbox !== undefined && notifications.length > 0) {
        await enqueueGithubOutboxJob(outbox.store, {
          payload: {
            installationId: outbox.installationId,
            notifications,
            owner: input.owner,
            pullNumber: input.pullNumber,
            repo: input.repo,
          },
          type: githubOutboxJobTypes.sendNotifications,
        });
        return;
      }

      await sendPullRequestNotifications(
        octokit,
        {
          owner: input.owner,
          pullNumber: input.pullNumber,
          repo: input.repo,
        },
        notifications,
      );
    },
    setStatuses: async (input, decisions) => {
      if (outbox !== undefined && decisions.length > 0) {
        await enqueueGithubOutboxJob(outbox.store, {
          payload: {
            decisions,
            installationId: outbox.installationId,
            owner: input.owner,
            repo: input.repo,
            sha: input.headSha,
          },
          type: githubOutboxJobTypes.setStatuses,
        });
        return;
      }

      await setCommitStatuses(
        octokit,
        {
          owner: input.owner,
          repo: input.repo,
          sha: input.headSha,
        },
        decisions,
      );
    },
    upsertComment: async (input, body) => {
      if (outbox !== undefined) {
        await enqueueGithubOutboxJob(outbox.store, {
          payload: {
            body,
            installationId: outbox.installationId,
            owner: input.owner,
            pullNumber: input.pullNumber,
            repo: input.repo,
          },
          type: githubOutboxJobTypes.upsertComment,
        });
        return;
      }

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

function getGithubOutbox(
  options: GithubHandlerOptions,
  installationId: number | undefined,
): { installationId: number; store: GithubOutboxStore } | undefined {
  if (installationId === undefined || options.stateStore?.enqueueOutboxJob === undefined) {
    return undefined;
  }

  return {
    installationId,
    store: {
      enqueueOutboxJob: options.stateStore.enqueueOutboxJob,
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

  if (options.stateStore?.beginWebhookDelivery !== undefined) {
    return options.stateStore.beginWebhookDelivery({
      action,
      deliveryId,
      event,
      payload,
    });
  }

  await recordWebhookDelivery(options, deliveryId, event, action, payload, "processing");
  return true;
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

  await options.stateStore?.recordWebhookDelivery?.({
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

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
