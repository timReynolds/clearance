import { describe, expect, it, vi } from "vitest";

import {
  executeGithubOutboxJob,
  runGithubOutboxOnce,
  type GithubOutboxInstallationClientFactory,
  type GithubOutboxOctokit,
  type GithubOutboxRunnerStore,
} from "../../src/github/index.js";

type CreateComment = GithubOutboxOctokit["rest"]["issues"]["createComment"];
type ListComments = GithubOutboxOctokit["rest"]["issues"]["listComments"];
type UpdateComment = GithubOutboxOctokit["rest"]["issues"]["updateComment"];
type RequestReviewers = GithubOutboxOctokit["rest"]["pulls"]["requestReviewers"];
type CreateCommitStatus = GithubOutboxOctokit["rest"]["repos"]["createCommitStatus"];

describe("GitHub outbox", () => {
  it("executes queued reviewer request jobs", async () => {
    const octokit = createOutboxOctokit();

    await executeGithubOutboxJob(
      {
        attempts: 1,
        id: "job-1",
        payload: {
          installationId: 123,
          owner: "acme",
          pullNumber: 42,
          repo: "clearance",
          reviewers: ["bob", "alice", "alice"],
        },
        type: "github.request-reviewers",
      },
      {
        getInstallationOctokit: vi.fn<
          GithubOutboxInstallationClientFactory["getInstallationOctokit"]
        >(async () => octokit),
      },
    );

    expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith({
      owner: "acme",
      pull_number: 42,
      repo: "clearance",
      reviewers: ["alice", "bob"],
    });
  });

  it("marks successful and terminal outbox jobs", async () => {
    const store: GithubOutboxRunnerStore = {
      claimOutboxJobs: vi.fn<GithubOutboxRunnerStore["claimOutboxJobs"]>(async () => [
        {
          attempts: 1,
          id: "job-1",
          payload: {
            body: "hello",
            installationId: 123,
            owner: "acme",
            pullNumber: 42,
            repo: "clearance",
          },
          type: "github.post-comment",
        },
        {
          attempts: 2,
          id: "job-2",
          payload: {},
          type: "github.missing",
        },
      ]),
      completeOutboxJob: vi.fn<GithubOutboxRunnerStore["completeOutboxJob"]>(async () => {}),
      failOutboxJob: vi.fn<GithubOutboxRunnerStore["failOutboxJob"]>(async () => {}),
    };

    const result = await runGithubOutboxOnce(
      {
        getInstallationOctokit: vi.fn<
          GithubOutboxInstallationClientFactory["getInstallationOctokit"]
        >(async () => createOutboxOctokit()),
      },
      store,
      {
        batchSize: 2,
        maxAttempts: 2,
      },
    );

    expect(result).toEqual({
      claimed: 2,
      failed: 0,
      succeeded: 1,
      terminalFailures: 1,
    });
    expect(store.completeOutboxJob).toHaveBeenCalledWith("job-1");
    expect(store.failOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "job-2",
        terminal: true,
      }),
    );
  });
});

function createOutboxOctokit(): GithubOutboxOctokit {
  return {
    rest: {
      issues: {
        createComment: vi.fn<CreateComment>(async ({ body }) => ({
          data: {
            body,
            id: 100,
          },
        })),
        listComments: vi.fn<ListComments>(async () => ({ data: [] })),
        updateComment: vi.fn<UpdateComment>(async ({ body, comment_id }) => ({
          data: {
            body,
            id: comment_id,
          },
        })),
      },
      pulls: {
        requestReviewers: vi.fn<RequestReviewers>(async () => ({})),
      },
      repos: {
        createCommitStatus: vi.fn<CreateCommitStatus>(async () => ({})),
      },
    },
  };
}
