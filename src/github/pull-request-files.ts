export type PullRequestFilesRef = {
  owner: string;
  pullNumber: number;
  repo: string;
};

export type PullRequestFilesOctokit = {
  rest: {
    pulls: {
      listFiles(parameters: {
        owner: string;
        page?: number;
        per_page?: number;
        pull_number: number;
        repo: string;
      }): Promise<{
        data: Array<{
          additions?: number;
          changes?: number;
          deletions?: number;
          filename: string;
          patch?: string;
          previous_filename?: string;
          status?: string;
        }>;
      }>;
    };
  };
};

export type PullRequestFileChange = {
  additions: number;
  deletions: number;
  filename: string;
  patch?: string;
  previousFilename?: string;
  status: "added" | "changed" | "copied" | "modified" | "removed" | "renamed";
};

export async function listChangedPullRequestFiles(
  octokit: PullRequestFilesOctokit,
  ref: PullRequestFilesRef,
  page = 1,
): Promise<string[]> {
  const response = await octokit.rest.pulls.listFiles({
    owner: ref.owner,
    page,
    per_page: 100,
    pull_number: ref.pullNumber,
    repo: ref.repo,
  });
  const filenames = response.data.map((file) => file.filename);

  if (response.data.length < 100) {
    return filenames;
  }

  return [...filenames, ...(await listChangedPullRequestFiles(octokit, ref, page + 1))];
}

export async function listPullRequestFileChanges(
  octokit: PullRequestFilesOctokit,
  ref: PullRequestFilesRef,
  page = 1,
): Promise<PullRequestFileChange[]> {
  const response = await octokit.rest.pulls.listFiles({
    owner: ref.owner,
    page,
    per_page: 100,
    pull_number: ref.pullNumber,
    repo: ref.repo,
  });
  const files = response.data.map((file): PullRequestFileChange => {
    return {
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      filename: file.filename,
      patch: file.patch,
      previousFilename: file.previous_filename,
      status: normalizePullRequestFileStatus(file.status),
    };
  });

  if (response.data.length < 100) {
    return files;
  }

  return [...files, ...(await listPullRequestFileChanges(octokit, ref, page + 1))];
}

function normalizePullRequestFileStatus(
  value: string | undefined,
): PullRequestFileChange["status"] {
  switch (value) {
    case "added":
    case "changed":
    case "copied":
    case "modified":
    case "removed":
    case "renamed":
      return value;
    default:
      return "modified";
  }
}
