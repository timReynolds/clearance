export type OpenPullRequestRef = {
  owner: string;
  repo: string;
};

export type OpenPullRequest = {
  author: string;
  headSha: string;
  labels: string[];
  number: number;
};

export type OpenPullRequestsOctokit = {
  rest: {
    pulls: {
      list(parameters: {
        owner: string;
        page?: number;
        per_page?: number;
        repo: string;
        state: "open";
      }): Promise<{
        data: Array<{
          head: {
            sha: string;
          };
          labels?: Array<
            | string
            | {
                name?: string;
              }
          >;
          number: number;
          user?: {
            login?: string;
          } | null;
        }>;
      }>;
    };
  };
};

export async function listOpenPullRequests(
  octokit: OpenPullRequestsOctokit,
  ref: OpenPullRequestRef,
  page = 1,
): Promise<OpenPullRequest[]> {
  const response = await octokit.rest.pulls.list({
    owner: ref.owner,
    page,
    per_page: 100,
    repo: ref.repo,
    state: "open",
  });
  const pullRequests = response.data.flatMap((pullRequest) => {
    const author = pullRequest.user?.login;
    if (author === undefined) {
      return [];
    }

    return [
      {
        author,
        headSha: pullRequest.head.sha,
        labels: getLabelNames(pullRequest.labels ?? []),
        number: pullRequest.number,
      },
    ];
  });

  if (response.data.length < 100) {
    return pullRequests;
  }

  return [...pullRequests, ...(await listOpenPullRequests(octokit, ref, page + 1))];
}

function getLabelNames(labels: Array<string | { name?: string }>): string[] {
  return labels
    .flatMap((label) => {
      if (typeof label === "string") {
        return [label];
      }

      return label.name === undefined ? [] : [label.name];
    })
    .toSorted(compareStrings);
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
