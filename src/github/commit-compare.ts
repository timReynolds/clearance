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
          files?: CommitCompareFileResponse[];
        };
      }>;
    };
  };
};

export type CommitCompareFileChange = {
  additions: number;
  deletions: number;
  filename: string;
  patch?: string;
  previousFilename?: string;
  status: string;
};

type CommitCompareFileResponse = {
  additions?: number;
  deletions?: number;
  filename: string;
  patch?: string;
  previous_filename?: string;
  status?: string;
};

export async function listChangedFilesBetweenCommits(
  octokit: CommitCompareOctokit,
  ref: CommitCompareRef,
): Promise<string[]> {
  const files = await listFileChangesBetweenCommits(octokit, ref);

  return files.map((file) => file.filename).toSorted(compareStrings);
}

export async function listFileChangesBetweenCommits(
  octokit: CommitCompareOctokit,
  ref: CommitCompareRef,
): Promise<CommitCompareFileChange[]> {
  const response = await octokit.rest.repos.compareCommitsWithBasehead({
    basehead: `${ref.base}...${ref.head}`,
    owner: ref.owner,
    repo: ref.repo,
  });

  return (response.data.files ?? [])
    .map((file): CommitCompareFileChange => {
      return {
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        filename: file.filename,
        patch: file.patch,
        previousFilename: file.previous_filename,
        status: file.status ?? "modified",
      };
    })
    .toSorted((left, right) => compareStrings(left.filename, right.filename));
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
