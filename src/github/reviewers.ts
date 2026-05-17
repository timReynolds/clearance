export type PullRequestReviewersRef = {
  owner: string;
  pullNumber: number;
  repo: string;
};

export type PullRequestReviewersOctokit = {
  rest: {
    pulls: {
      requestReviewers(parameters: {
        owner: string;
        pull_number: number;
        repo: string;
        reviewers: string[];
      }): Promise<unknown>;
    };
  };
};

export async function requestPullRequestReviewers(
  octokit: PullRequestReviewersOctokit,
  ref: PullRequestReviewersRef,
  reviewers: string[],
): Promise<void> {
  const uniqueReviewers = [...new Set(reviewers)].toSorted(compareStrings);
  if (uniqueReviewers.length === 0) {
    return;
  }

  await octokit.rest.pulls.requestReviewers({
    owner: ref.owner,
    pull_number: ref.pullNumber,
    repo: ref.repo,
    reviewers: uniqueReviewers,
  });
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
