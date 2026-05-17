export type CommitCompareRef = {
  base: string;
  head: string;
  owner: string;
  repo: string;
};

export type CommitCompareOctokit = {
  rest: {
    repos: {
      compareCommitsWithBasehead(parameters: {
        basehead: string;
        owner: string;
        repo: string;
      }): Promise<{
        data: {
          files?: Array<{
            filename: string;
          }>;
        };
      }>;
    };
  };
};

export async function listChangedFilesBetweenCommits(
  octokit: CommitCompareOctokit,
  ref: CommitCompareRef,
): Promise<string[]> {
  const response = await octokit.rest.repos.compareCommitsWithBasehead({
    basehead: `${ref.base}...${ref.head}`,
    owner: ref.owner,
    repo: ref.repo,
  });

  return (response.data.files ?? []).map((file) => file.filename).toSorted(compareStrings);
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
