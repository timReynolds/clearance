import { describe, expect, it, vi } from "vitest";

import {
  listPullRequestReviewerSignals,
  type ReviewerSignalsOctokit,
} from "../../src/github/index.js";

type ListReviews = ReviewerSignalsOctokit["rest"]["pulls"]["listReviews"];
type ListCommits = ReviewerSignalsOctokit["rest"]["repos"]["listCommits"];
type SearchIssues = ReviewerSignalsOctokit["rest"]["search"]["issuesAndPullRequests"];

describe("listPullRequestReviewerSignals", () => {
  it("returns best-effort reviewer scores from GitHub edge data", async () => {
    const octokit = createReviewerSignalsOctokit({
      authoredFiles: new Map([
        ["alice:src/a.ts", true],
        ["bob:src/a.ts", true],
        ["bob:src/b.ts", true],
      ]),
      currentLoads: new Map([
        ["alice", 4],
        ["bob", 1],
      ]),
      reviews: ["alice", "alice", "bob"],
    });

    const signals = await listPullRequestReviewerSignals(octokit, {
      changedFiles: ["src/a.ts", "src/b.ts"],
      owner: "acme",
      pullNumber: 42,
      repo: "clearance",
      reviewers: ["bob", "alice", "bob"],
    });

    expect(signals).toEqual([
      {
        blameCoverage: 0.5,
        currentLoad: 4,
        login: "alice",
        reviewHistory: 1,
        roundRobinRank: 0,
      },
      {
        blameCoverage: 1,
        currentLoad: 1,
        login: "bob",
        reviewHistory: 0.5,
        roundRobinRank: 1,
      },
    ]);
  });

  it("returns zeroed signals when GitHub signal lookups fail", async () => {
    const octokit = createReviewerSignalsOctokit({
      failCommits: true,
      failReviews: true,
      failSearch: true,
    });

    await expect(
      listPullRequestReviewerSignals(octokit, {
        changedFiles: ["src/a.ts"],
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
        reviewers: ["alice"],
      }),
    ).resolves.toEqual([
      {
        blameCoverage: 0,
        currentLoad: 0,
        login: "alice",
        reviewHistory: 0,
        roundRobinRank: 0,
      },
    ]);
  });
});

function createReviewerSignalsOctokit(options: {
  authoredFiles?: Map<string, boolean>;
  currentLoads?: Map<string, number>;
  failCommits?: boolean;
  failReviews?: boolean;
  failSearch?: boolean;
  reviews?: string[];
}): ReviewerSignalsOctokit {
  const listReviews = vi.fn<ListReviews>(async () => {
    if (options.failReviews === true) {
      throw new Error("reviews unavailable");
    }

    return {
      data: (options.reviews ?? []).map((login) => ({
        user: {
          login,
        },
      })),
    };
  });
  const issuesAndPullRequests = vi.fn<SearchIssues>(async ({ q }) => {
    if (options.failSearch === true) {
      throw new Error("search unavailable");
    }

    const reviewer = q.match(/review-requested:(?<reviewer>\S+)/)?.groups?.reviewer ?? "";
    return {
      data: {
        total_count: options.currentLoads?.get(reviewer) ?? 0,
      },
    };
  });
  const listCommits = vi.fn<ListCommits>(async ({ author, path }) => {
    if (options.failCommits === true) {
      throw new Error("commits unavailable");
    }

    return {
      data: options.authoredFiles?.get(`${author}:${path}`) === true ? [{}] : [],
    };
  });

  return {
    rest: {
      pulls: {
        listReviews,
      },
      repos: {
        listCommits,
      },
      search: {
        issuesAndPullRequests,
      },
    },
  };
}
