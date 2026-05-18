import { describe, expect, it, vi } from "vitest";

import {
  runGithubEscalationSweep,
  type GithubEscalationRunnerOctokit,
} from "../../src/github/index.js";
import { createEmptyClearanceState, renderClearanceComment } from "../../src/state/index.js";

type CreateComment = GithubEscalationRunnerOctokit["rest"]["issues"]["createComment"];
type ListComments = GithubEscalationRunnerOctokit["rest"]["issues"]["listComments"];
type UpdateComment = GithubEscalationRunnerOctokit["rest"]["issues"]["updateComment"];
type ListPulls = GithubEscalationRunnerOctokit["rest"]["pulls"]["list"];
type RequestReviewers = GithubEscalationRunnerOctokit["rest"]["pulls"]["requestReviewers"];

describe("runGithubEscalationSweep", () => {
  it("processes open pull requests with sticky Clearance state", async () => {
    const octokit = createEscalationRunnerOctokit({
      stickyCommentBody: renderClearanceComment({
        ...createEmptyClearanceState(),
        assignments: [
          {
            assignedAt: "2026-05-17T07:00:00.000Z",
            requirementIdentity: "and:platform",
            reviewers: ["alice"],
          },
        ],
        requirements: [
          {
            approvedBy: [],
            assignedReviewers: ["alice"],
            eligibleReviewers: ["alice", "bob"],
            escalateAfter: "2h",
            identity: "and:platform",
            label: "Platform",
            pendingSince: "2026-05-17T07:00:00.000Z",
            requiredCount: 1,
            status: "pending",
            type: "and",
            warnAfter: "1h",
          },
        ],
      }),
    });

    const result = await runGithubEscalationSweep(
      octokit,
      {
        owner: "acme",
        repo: "clearance",
      },
      "2026-05-17T12:00:00.000Z",
    );

    expect(result).toEqual({
      pullRequests: [
        {
          actions: 2,
          pullNumber: 42,
          sideEffectFailures: 0,
          status: "processed",
        },
      ],
      repository: "acme/clearance",
    });
    expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith({
      owner: "acme",
      pull_number: 42,
      repo: "clearance",
      reviewers: ["bob"],
    });
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Warn assigned reviewers for and:platform: @alice",
      }),
    );
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("<!-- clearance-state:v1"),
        comment_id: 100,
      }),
    );
  });

  it("skips pull requests that do not have parseable sticky state", async () => {
    const octokit = createEscalationRunnerOctokit({
      stickyCommentBody: undefined,
    });

    const result = await runGithubEscalationSweep(
      octokit,
      {
        owner: "acme",
        repo: "clearance",
      },
      "2026-05-17T12:00:00.000Z",
    );

    expect(result.pullRequests).toEqual([
      {
        pullNumber: 42,
        reason: "missing sticky Clearance comment",
        status: "skipped",
      },
    ]);
    expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
  });
});

function createEscalationRunnerOctokit(options: {
  stickyCommentBody: string | undefined;
}): GithubEscalationRunnerOctokit {
  const list = vi.fn<ListPulls>(async () => ({
    data: [
      {
        head: {
          sha: "head-sha",
        },
        number: 42,
        user: {
          login: "author",
        },
      },
    ],
  }));
  const listComments = vi.fn<ListComments>(async () => ({
    data:
      options.stickyCommentBody === undefined
        ? []
        : [
            {
              body: options.stickyCommentBody,
              id: 100,
            },
          ],
  }));

  return {
    rest: {
      issues: {
        createComment: vi.fn<CreateComment>(async ({ body }) => ({
          data: {
            body,
            id: 101,
          },
        })),
        listComments,
        updateComment: vi.fn<UpdateComment>(async ({ body, comment_id }) => ({
          data: {
            body,
            id: comment_id,
          },
        })),
      },
      pulls: {
        list,
        requestReviewers: vi.fn<RequestReviewers>(async () => ({})),
      },
    },
  };
}
