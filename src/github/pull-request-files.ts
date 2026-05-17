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
          filename: string;
        }>;
      }>;
    };
  };
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
