export type ReviewerSignalsRef = {
  changedFiles: string[];
  owner: string;
  pullNumber: number;
  repo: string;
  reviewers: string[];
};

export type GithubReviewerSignal = {
  blameCoverage: number;
  currentLoad: number;
  login: string;
  reviewHistory: number;
  roundRobinRank: number;
};

export type ReviewerSignalsOctokit = {
  rest: {
    pulls: {
      listReviews(parameters: {
        owner: string;
        page?: number;
        per_page?: number;
        pull_number: number;
        repo: string;
      }): Promise<{
        data: Array<{
          user?: {
            login?: string;
          } | null;
        }>;
      }>;
    };
    repos: {
      listCommits(parameters: {
        author: string;
        owner: string;
        path: string;
        per_page?: number;
        repo: string;
      }): Promise<{
        data: unknown[];
      }>;
    };
    search: {
      issuesAndPullRequests(parameters: { per_page?: number; q: string }): Promise<{
        data: {
          total_count: number;
        };
      }>;
    };
  };
};

export async function listPullRequestReviewerSignals(
  octokit: ReviewerSignalsOctokit,
  ref: ReviewerSignalsRef,
): Promise<GithubReviewerSignal[]> {
  const reviewers = [...new Set(ref.reviewers)].toSorted(compareStrings);
  const [reviewHistoryCounts, currentLoads, blameCoverageByReviewer] = await Promise.all([
    getReviewHistoryCounts(octokit, ref, reviewers),
    getCurrentReviewLoads(octokit, ref, reviewers),
    getBlameCoverageByReviewer(octokit, ref, reviewers),
  ]);
  const maxReviewHistory = Math.max(1, ...reviewHistoryCounts.values());

  return reviewers.map((login, roundRobinRank) => ({
    blameCoverage: blameCoverageByReviewer.get(login) ?? 0,
    currentLoad: currentLoads.get(login) ?? 0,
    login,
    reviewHistory: (reviewHistoryCounts.get(login) ?? 0) / maxReviewHistory,
    roundRobinRank,
  }));
}

async function getReviewHistoryCounts(
  octokit: ReviewerSignalsOctokit,
  ref: ReviewerSignalsRef,
  reviewers: string[],
): Promise<Map<string, number>> {
  const reviewerSet = new Set(reviewers);
  const counts = new Map(reviewers.map((reviewer) => [reviewer, 0]));
  const reviews = await listPullRequestReviews(octokit, ref);

  for (const review of reviews) {
    const login = review.user?.login;
    if (login !== undefined && reviewerSet.has(login)) {
      counts.set(login, (counts.get(login) ?? 0) + 1);
    }
  }

  return counts;
}

async function listPullRequestReviews(
  octokit: ReviewerSignalsOctokit,
  ref: ReviewerSignalsRef,
  page = 1,
): Promise<Array<{ user?: { login?: string } | null }>> {
  try {
    const response = await octokit.rest.pulls.listReviews({
      owner: ref.owner,
      page,
      per_page: 100,
      pull_number: ref.pullNumber,
      repo: ref.repo,
    });

    if (response.data.length < 100) {
      return response.data;
    }

    return [...response.data, ...(await listPullRequestReviews(octokit, ref, page + 1))];
  } catch {
    return [];
  }
}

async function getCurrentReviewLoads(
  octokit: ReviewerSignalsOctokit,
  ref: ReviewerSignalsRef,
  reviewers: string[],
): Promise<Map<string, number>> {
  const entries = await Promise.all(
    reviewers.map(async (reviewer): Promise<[string, number]> => {
      try {
        const response = await octokit.rest.search.issuesAndPullRequests({
          per_page: 1,
          q: `repo:${ref.owner}/${ref.repo} is:pr is:open review-requested:${reviewer}`,
        });

        return [reviewer, response.data.total_count];
      } catch {
        return [reviewer, 0];
      }
    }),
  );

  return new Map(entries);
}

async function getBlameCoverageByReviewer(
  octokit: ReviewerSignalsOctokit,
  ref: ReviewerSignalsRef,
  reviewers: string[],
): Promise<Map<string, number>> {
  if (ref.changedFiles.length === 0) {
    return new Map(reviewers.map((reviewer) => [reviewer, 0]));
  }

  const entries = await Promise.all(
    reviewers.map(async (reviewer): Promise<[string, number]> => {
      const touchedFiles = await Promise.all(
        ref.changedFiles.map(async (file) => hasAuthoredFile(octokit, ref, reviewer, file)),
      );
      const coverage = touchedFiles.filter(Boolean).length / ref.changedFiles.length;

      return [reviewer, coverage];
    }),
  );

  return new Map(entries);
}

async function hasAuthoredFile(
  octokit: ReviewerSignalsOctokit,
  ref: ReviewerSignalsRef,
  reviewer: string,
  file: string,
): Promise<boolean> {
  try {
    const response = await octokit.rest.repos.listCommits({
      author: reviewer,
      owner: ref.owner,
      path: file,
      per_page: 1,
      repo: ref.repo,
    });

    return response.data.length > 0;
  } catch {
    return false;
  }
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
