import { describe, expect, it, vi } from "vitest";

import { setCommitStatuses, type GithubStatusesOctokit } from "../../src/github/index.js";

type CreateCommitStatus = GithubStatusesOctokit["rest"]["repos"]["createCommitStatus"];

describe("setCommitStatuses", () => {
  it("writes GitHub commit statuses for Clearance checks", async () => {
    const createCommitStatus = vi.fn<CreateCommitStatus>(async () => ({}));
    const octokit: GithubStatusesOctokit = {
      rest: {
        repos: {
          createCommitStatus,
        },
      },
    };

    await setCommitStatuses(
      octokit,
      {
        owner: "acme",
        repo: "clearance",
        sha: "abc123",
      },
      [
        {
          context: "clearance/config",
          description: "OWNERS.toml configuration is valid",
          state: "success",
        },
        {
          context: "clearance/review",
          description: "1 review requirement pending",
          state: "pending",
        },
      ],
    );

    expect(createCommitStatus).toHaveBeenCalledWith({
      context: "clearance/config",
      description: "OWNERS.toml configuration is valid",
      owner: "acme",
      repo: "clearance",
      sha: "abc123",
      state: "success",
    });
    expect(createCommitStatus).toHaveBeenCalledWith({
      context: "clearance/review",
      description: "1 review requirement pending",
      owner: "acme",
      repo: "clearance",
      sha: "abc123",
      state: "pending",
    });
  });

  it("truncates descriptions to GitHub's commit status limit", async () => {
    const createCommitStatus = vi.fn<CreateCommitStatus>(async () => ({}));
    const octokit: GithubStatusesOctokit = {
      rest: {
        repos: {
          createCommitStatus,
        },
      },
    };
    const description = "x".repeat(200);

    await setCommitStatuses(
      octokit,
      {
        owner: "acme",
        repo: "clearance",
        sha: "abc123",
      },
      [
        {
          context: "clearance/review",
          description,
          state: "failure",
        },
      ],
    );

    expect(createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        description: `${"x".repeat(137)}...`,
      }),
    );
  });
});
