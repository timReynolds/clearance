import { describe, expect, it, vi } from "vitest";

import {
  sendPullRequestNotifications,
  type NotificationCommentOctokit,
} from "../../src/github/index.js";

type CreateComment = NotificationCommentOctokit["rest"]["issues"]["createComment"];

describe("sendPullRequestNotifications", () => {
  it("posts one notification comment per triggered notification", async () => {
    const createComment = vi.fn<CreateComment>(async () => ({}));

    await sendPullRequestNotifications(
      {
        rest: {
          issues: {
            createComment,
          },
        },
      },
      {
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
      },
      [
        {
          identity: "notify:.:teams=@org/docs:users=@alice",
          teams: ["@org/docs"],
          triggers: [
            {
              changedFile: "docs/a.md",
              matchedPath: "docs/a.md",
              notifyIndex: 0,
              ownersDirectory: ".",
              ownersPath: "OWNERS.toml",
              pattern: "docs/**",
            },
            {
              changedFile: "docs/a.md",
              matchedPath: "docs/a.md",
              notifyIndex: 0,
              ownersDirectory: ".",
              ownersPath: "OWNERS.toml",
              pattern: "**/*.md",
            },
          ],
          users: ["@alice"],
        },
      ],
    );

    expect(createComment).toHaveBeenCalledWith({
      body: "Clearance notification @alice @org/docs\n\nTriggered by:\n- `docs/a.md`",
      issue_number: 42,
      owner: "acme",
      repo: "clearance",
    });
  });
});
