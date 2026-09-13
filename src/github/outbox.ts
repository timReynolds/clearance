import type { CheckDecision } from "../checks/index.js";
import type { OutboxJobRecord } from "../db/index.js";
import type { NotificationRecord } from "../resolution/index.js";
import { sendPullRequestNotifications, type NotificationCommentOctokit } from "./notifications.js";
import { requestPullRequestReviewers, type PullRequestReviewersOctokit } from "./reviewers.js";
import { setCommitStatuses, type GithubStatusesOctokit } from "./statuses.js";
import { upsertStickyClearanceComment, type StickyCommentOctokit } from "./sticky-comment.js";

export const githubOutboxJobTypes = {
  postComment: "github.post-comment",
  requestReviewers: "github.request-reviewers",
  sendNotifications: "github.send-notifications",
  setStatuses: "github.set-statuses",
  upsertComment: "github.upsert-comment",
} as const;

export type GithubOutboxJobType = (typeof githubOutboxJobTypes)[keyof typeof githubOutboxJobTypes];

export type GithubOutboxOctokit = GithubStatusesOctokit &
  NotificationCommentOctokit &
  PullRequestReviewersOctokit &
  StickyCommentOctokit;

export type GithubOutboxInstallationClientFactory = {
  getInstallationOctokit(installationId: number): Promise<GithubOutboxOctokit>;
};

type GithubJobBasePayload = {
  installationId: number;
  owner: string;
  repo: string;
};

export type GithubUpsertCommentPayload = GithubJobBasePayload & {
  body: string;
  pullNumber: number;
};

export type GithubPostCommentPayload = GithubJobBasePayload & {
  body: string;
  pullNumber: number;
};

export type GithubRequestReviewersPayload = GithubJobBasePayload & {
  pullNumber: number;
  reviewers: string[];
};

export type GithubSetStatusesPayload = GithubJobBasePayload & {
  decisions: CheckDecision[];
  sha: string;
};

export type GithubSendNotificationsPayload = GithubJobBasePayload & {
  notifications: NotificationRecord[];
  pullNumber: number;
};

export type GithubOutboxJobInput =
  | {
      payload: GithubUpsertCommentPayload;
      type: typeof githubOutboxJobTypes.upsertComment;
    }
  | {
      payload: GithubPostCommentPayload;
      type: typeof githubOutboxJobTypes.postComment;
    }
  | {
      payload: GithubRequestReviewersPayload;
      type: typeof githubOutboxJobTypes.requestReviewers;
    }
  | {
      payload: GithubSetStatusesPayload;
      type: typeof githubOutboxJobTypes.setStatuses;
    }
  | {
      payload: GithubSendNotificationsPayload;
      type: typeof githubOutboxJobTypes.sendNotifications;
    };

export async function executeGithubOutboxJob(
  job: OutboxJobRecord,
  installationClientFactory: GithubOutboxInstallationClientFactory,
): Promise<void> {
  if (!isGithubOutboxJobType(job.type)) {
    throw new Error(`unsupported outbox job type ${job.type}`);
  }

  switch (job.type) {
    case githubOutboxJobTypes.upsertComment: {
      const payload = parseUpsertCommentPayload(job.payload);
      const octokit = await installationClientFactory.getInstallationOctokit(
        payload.installationId,
      );
      await upsertStickyClearanceComment(
        octokit,
        {
          owner: payload.owner,
          pullNumber: payload.pullNumber,
          repo: payload.repo,
        },
        payload.body,
      );
      return;
    }
    case githubOutboxJobTypes.postComment: {
      const payload = parsePostCommentPayload(job.payload);
      const octokit = await installationClientFactory.getInstallationOctokit(
        payload.installationId,
      );
      await octokit.rest.issues.createComment({
        body: payload.body,
        issue_number: payload.pullNumber,
        owner: payload.owner,
        repo: payload.repo,
      });
      return;
    }
    case githubOutboxJobTypes.requestReviewers: {
      const payload = parseRequestReviewersPayload(job.payload);
      const octokit = await installationClientFactory.getInstallationOctokit(
        payload.installationId,
      );
      await requestPullRequestReviewers(
        octokit,
        {
          owner: payload.owner,
          pullNumber: payload.pullNumber,
          repo: payload.repo,
        },
        payload.reviewers,
      );
      return;
    }
    case githubOutboxJobTypes.setStatuses: {
      const payload = parseSetStatusesPayload(job.payload);
      const octokit = await installationClientFactory.getInstallationOctokit(
        payload.installationId,
      );
      await setCommitStatuses(
        octokit,
        {
          owner: payload.owner,
          repo: payload.repo,
          sha: payload.sha,
        },
        payload.decisions,
      );
      return;
    }
    case githubOutboxJobTypes.sendNotifications: {
      const payload = parseSendNotificationsPayload(job.payload);
      const octokit = await installationClientFactory.getInstallationOctokit(
        payload.installationId,
      );
      await sendPullRequestNotifications(
        octokit,
        {
          owner: payload.owner,
          pullNumber: payload.pullNumber,
          repo: payload.repo,
        },
        payload.notifications,
      );
    }
  }
}

function isGithubOutboxJobType(type: string): type is GithubOutboxJobType {
  return Object.values(githubOutboxJobTypes).some((jobType) => jobType === type);
}

function parseUpsertCommentPayload(payload: Record<string, unknown>): GithubUpsertCommentPayload {
  assertBasePayload(payload);
  const pullNumber = readNumber(payload, "pullNumber");
  const body = readString(payload, "body");

  return {
    body,
    installationId: payload.installationId,
    owner: payload.owner,
    pullNumber,
    repo: payload.repo,
  };
}

function parsePostCommentPayload(payload: Record<string, unknown>): GithubPostCommentPayload {
  return parseUpsertCommentPayload(payload);
}

function parseRequestReviewersPayload(
  payload: Record<string, unknown>,
): GithubRequestReviewersPayload {
  assertBasePayload(payload);
  const pullNumber = readNumber(payload, "pullNumber");
  const reviewers = readStringArray(payload, "reviewers");

  return {
    installationId: payload.installationId,
    owner: payload.owner,
    pullNumber,
    repo: payload.repo,
    reviewers,
  };
}

function parseSetStatusesPayload(payload: Record<string, unknown>): GithubSetStatusesPayload {
  assertBasePayload(payload);
  const sha = readString(payload, "sha");
  const decisions = payload.decisions;
  if (!Array.isArray(decisions) || !decisions.every(isCheckDecision)) {
    throw new Error("outbox payload field decisions must be check decisions");
  }

  return {
    decisions,
    installationId: payload.installationId,
    owner: payload.owner,
    repo: payload.repo,
    sha,
  };
}

function parseSendNotificationsPayload(
  payload: Record<string, unknown>,
): GithubSendNotificationsPayload {
  assertBasePayload(payload);
  const pullNumber = readNumber(payload, "pullNumber");
  const notifications = payload.notifications;
  if (!Array.isArray(notifications) || !notifications.every(isNotificationRecord)) {
    throw new Error("outbox payload field notifications must be notification records");
  }

  return {
    installationId: payload.installationId,
    notifications,
    owner: payload.owner,
    pullNumber,
    repo: payload.repo,
  };
}

function assertBasePayload(
  payload: Record<string, unknown>,
): asserts payload is Record<string, unknown> & GithubJobBasePayload {
  if (
    typeof payload.installationId !== "number" ||
    typeof payload.owner !== "string" ||
    typeof payload.repo !== "string"
  ) {
    throw new Error("outbox payload is missing GitHub installation or repository fields");
  }
}

function readNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number") {
    throw new Error(`outbox payload field ${key} must be a number`);
  }

  return value;
}

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new Error(`outbox payload field ${key} must be a string`);
  }

  return value;
}

function readStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`outbox payload field ${key} must be a string array`);
  }

  return value;
}

function isCheckDecision(value: unknown): value is CheckDecision {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    (record.context === "clearance/config" || record.context === "clearance/review") &&
    typeof record.description === "string" &&
    ["error", "failure", "pending", "success"].includes(String(record.state))
  );
}

function isNotificationRecord(value: unknown): value is NotificationRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.identity === "string" &&
    Array.isArray(record.teams) &&
    record.teams.every((team) => typeof team === "string") &&
    Array.isArray(record.users) &&
    record.users.every((user) => typeof user === "string") &&
    Array.isArray(record.triggers)
  );
}
