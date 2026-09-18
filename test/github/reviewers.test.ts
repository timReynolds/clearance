import { describe, expect, it, vi } from "vitest";

import {
  requestPullRequestReviewers,
  type PullRequestReviewersOctokit,
} from "../../src/github/index.js";

type RequestReviewers = PullRequestReviewersOctokit["rest"]["pulls"]["requestReviewers"];

describe("requestPullRequestReviewers", () => {
  it("deduplicates and sorts reviewers before requesting them", async () => {
    const requestReviewers = vi.fn<RequestReviewers>(async () => ({}));
    const octokit = createReviewersOctokit(requestReviewers);

    await requestPullRequestReviewers(
      octokit,
      {
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
      },
      ["zoe", "alice", "zoe"],
    );

    expect(requestReviewers).toHaveBeenCalledWith({
      owner: "acme",
      pull_number: 42,
      repo: "clearance",
      reviewers: ["alice", "zoe"],
    });
  });

  it("skips GitHub calls when no reviewers are selected", async () => {
    const requestReviewers = vi.fn<RequestReviewers>(async () => ({}));
    const octokit = createReviewersOctokit(requestReviewers);

    await requestPullRequestReviewers(
      octokit,
      {
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
      },
      [],
    );

    expect(requestReviewers).not.toHaveBeenCalled();
  });
});

function createReviewersOctokit(requestReviewers: RequestReviewers): PullRequestReviewersOctokit {
  return {
    rest: {
      pulls: {
        requestReviewers,
      },
    },
  };
}
