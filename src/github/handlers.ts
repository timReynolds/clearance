import type { Webhooks } from "@octokit/webhooks";

import {
  listChangedFilesBetweenCommits,
  listChangedPullRequestFiles,
  listPullRequestFileChanges,
  listPullRequestReviewerSignals,
  loadOwnershipTree,
  parseReviewThreadMarker,
  resolveGithubIdentities,
  stripReviewThreadMarker,
  type CommitCompareOctokit,
  type GithubIdentityOctokit,
  type GithubStatusesOctokit,
  type NotificationCommentOctokit,
  type OwnershipTreeOctokit,
  type PullRequestFilesOctokit,
  type PullRequestFileChange,
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
import type { ReviewPatchsetInput, ReviewPullRequestRef } from "../review/index.js";
import {
  commitGithubReviewTransition,
  type GithubReviewTransitionStore,
} from "./review-transition.js";

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

export type GithubHandlerStateStore = GithubReviewTransitionStore & {
  beginWebhookDelivery(input: {
    action?: string;
    deliveryId: string;
    event: string;
    payload?: unknown;
  }): Promise<boolean>;
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
};

export type GithubHandlerReviewStore = {
  ingestGithubReviewComment(
    ref: ReviewPullRequestRef,
    input: {
      authorLogin: string;
      body: string;
      createdAt: string;
      githubCommentId: number;
      githubNodeId?: string;
      githubRootCommentId?: number;
      githubThreadNodeId?: string;
      githubUrl?: string;
      line?: number;
      marker: string;
      path: string;
      side?: "LEFT" | "RIGHT";
      sourceText?: string;
      threadId: string;
    },
  ): Promise<boolean>;
  recordPatchset(
    ref: ReviewPullRequestRef,
    input: ReviewPatchsetInput,
  ): Promise<number | undefined>;
};

export type GithubHandlerOptions = {
  reviewStore: GithubHandlerReviewStore;
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
        await recordReviewPatchset(input, payload, octokit, options);

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
      if (payload.action !== "submitted" && payload.action !== "dismissed") {
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
            reviewState: payload.action === "dismissed" ? "dismissed" : payload.review.state,
          },
          buildWorkflowDependencies(octokit, options, installationId),
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

  webhooks.on("pull_request_review_comment", async ({ id, name, payload }) => {
    const shouldProcess = await beginWebhookDelivery(options, id, name, payload.action, payload);
    if (!shouldProcess) {
      return;
    }

    try {
      if (payload.action !== "created" && payload.action !== "edited") {
        await recordWebhookDelivery(options, id, name, payload.action, payload, "processed");
        return;
      }

      const body = payload.comment.body ?? "";
      const marker = parseReviewThreadMarker(body);
      if (marker === undefined) {
        await recordWebhookDelivery(options, id, name, payload.action, payload, "processed");
        return;
      }

      await options.reviewStore.ingestGithubReviewComment(
        {
          owner: payload.repository.owner.login,
          pullNumber: payload.pull_request.number,
          repo: payload.repository.name,
        },
        {
          authorLogin: payload.comment.user?.login ?? "unknown",
          body: stripReviewThreadMarker(body),
          createdAt: payload.comment.created_at,
          githubCommentId: payload.comment.id,
          githubNodeId: payload.comment.node_id,
          githubRootCommentId: payload.comment.in_reply_to_id ?? payload.comment.id,
          githubUrl: payload.comment.html_url,
          line: payload.comment.line ?? undefined,
          marker: body.slice(body.indexOf("<!-- clearance-thread:v1")).trim(),
          path: payload.comment.path,
          side: payload.comment.side === "LEFT" ? "LEFT" : "RIGHT",
          sourceText: getReviewCommentSourceText(
            payload.comment.diff_hunk,
            payload.comment.line ?? undefined,
            payload.comment.side === "LEFT" ? "LEFT" : "RIGHT",
          ),
          threadId: marker.threadId,
        },
      );

      await recordWebhookDelivery(options, id, name, payload.action, payload, "processed");
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

async function recordReviewPatchset(
  input: PullRequestWorkflowInput,
  payload: unknown,
  octokit: GithubWorkflowOctokit,
  options: GithubHandlerOptions,
): Promise<void> {
  const files = await listPullRequestFileChanges(octokit, {
    owner: input.owner,
    pullNumber: input.pullNumber,
    repo: input.repo,
  });
  await options.reviewStore.recordPatchset(
    {
      owner: input.owner,
      pullNumber: input.pullNumber,
      repo: input.repo,
    },
    {
      actor: input.sender,
      baseSha: getPullRequestBaseSha(payload),
      createdAt: input.now,
      eventType: getPatchsetEventType(payload),
      files: files.map(mapReviewPatchsetFile),
      forcePush: getSynchronizeForced(payload),
      headSha: input.headSha,
      parentSha: getSynchronizeBeforeSha(payload),
    },
  );
}

function mapReviewPatchsetFile(file: PullRequestFileChange): ReviewPatchsetInput["files"][number] {
  return {
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
    path: file.filename,
    previousPath: file.previousFilename,
    status: mapReviewFileStatus(file.status),
  };
}

function mapReviewFileStatus(
  status: PullRequestFileChange["status"],
): ReviewPatchsetInput["files"][number]["status"] {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "changed":
    case "copied":
    case "modified":
      return "modified";
  }
}

function getPatchsetEventType(payload: unknown): ReviewPatchsetInput["eventType"] {
  const action = getPayloadAction(payload);
  if (action === "opened" || action === "reopened" || action === "ready_for_review") {
    return "opened";
  }

  return getSynchronizeForced(payload) ? "force_push" : "synchronize";
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
    resolveIdentities: async (tree) => resolveGithubIdentities(octokit, tree.files),
    commitTransition: (input, transition) =>
      commitGithubReviewTransition(options.stateStore, input, installationId, transition),
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

function getSynchronizeForced(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("forced" in payload)) {
    return false;
  }

  return payload.forced === true;
}

function getPullRequestBaseSha(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("pull_request" in payload)) {
    return undefined;
  }

  const pullRequest = payload.pull_request;
  if (typeof pullRequest !== "object" || pullRequest === null || !("base" in pullRequest)) {
    return undefined;
  }

  const base = pullRequest.base;
  if (typeof base !== "object" || base === null || !("sha" in base)) {
    return undefined;
  }

  return typeof base.sha === "string" ? base.sha : undefined;
}

function getPayloadAction(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("action" in payload)) {
    return undefined;
  }

  return typeof payload.action === "string" ? payload.action : undefined;
}

function getReviewCommentSourceText(
  diffHunk: string | undefined,
  lineNumber: number | undefined,
  side: "LEFT" | "RIGHT",
): string | undefined {
  if (diffHunk === undefined || lineNumber === undefined) {
    return undefined;
  }

  let leftLineNumber: number | undefined;
  let rightLineNumber: number | undefined;

  for (const rawLine of diffHunk.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk?.[1] !== undefined && hunk[2] !== undefined) {
      leftLineNumber = Number.parseInt(hunk[1], 10);
      rightLineNumber = Number.parseInt(hunk[2], 10);
      continue;
    }

    if (leftLineNumber === undefined || rightLineNumber === undefined) {
      continue;
    }

    if (rawLine.startsWith("+")) {
      if (side === "RIGHT" && rightLineNumber === lineNumber) {
        return rawLine.slice(1);
      }
      rightLineNumber += 1;
      continue;
    }

    if (rawLine.startsWith("-")) {
      if (side === "LEFT" && leftLineNumber === lineNumber) {
        return rawLine.slice(1);
      }
      leftLineNumber += 1;
      continue;
    }

    if (rawLine.startsWith(" ")) {
      if (
        (side === "LEFT" && leftLineNumber === lineNumber) ||
        (side === "RIGHT" && rightLineNumber === lineNumber)
      ) {
        return rawLine.slice(1);
      }
      leftLineNumber += 1;
      rightLineNumber += 1;
    }
  }

  return undefined;
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
