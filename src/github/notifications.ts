import type { NotificationRecord } from "../resolution/index.js";
import type { PullRequestRef } from "./sticky-comment.js";

export type NotificationCommentOctokit = {
  rest: {
    issues: {
      createComment(parameters: {
        body: string;
        issue_number: number;
        owner: string;
        repo: string;
      }): Promise<unknown>;
    };
  };
};

export async function sendPullRequestNotifications(
  octokit: NotificationCommentOctokit,
  pullRequest: PullRequestRef,
  notifications: NotificationRecord[],
): Promise<void> {
  await Promise.all(
    notifications.map((notification) =>
      octokit.rest.issues.createComment({
        body: renderNotificationComment(notification),
        issue_number: pullRequest.pullNumber,
        owner: pullRequest.owner,
        repo: pullRequest.repo,
      }),
    ),
  );
}

function renderNotificationComment(notification: NotificationRecord): string {
  const mentions = [...notification.teams, ...notification.users]
    .toSorted(compareStrings)
    .join(" ");
  const changedFiles = [
    ...new Set(notification.triggers.map((trigger) => trigger.changedFile)),
  ].toSorted(compareStrings);

  return [
    `Clearance notification ${mentions}`.trim(),
    "",
    "Triggered by:",
    ...changedFiles.map((file) => `- \`${file}\``),
  ].join("\n");
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
