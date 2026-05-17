import type { CheckDecision } from "../checks/index.js";

export type CommitStatusRef = {
  owner: string;
  repo: string;
  sha: string;
};

export type GithubStatusesOctokit = {
  rest: {
    repos: {
      createCommitStatus(parameters: {
        context: string;
        description: string;
        owner: string;
        repo: string;
        sha: string;
        state: CheckDecision["state"];
      }): Promise<unknown>;
    };
  };
};

export async function setCommitStatus(
  octokit: GithubStatusesOctokit,
  ref: CommitStatusRef,
  decision: CheckDecision,
): Promise<void> {
  await octokit.rest.repos.createCommitStatus({
    context: decision.context,
    description: decision.description,
    owner: ref.owner,
    repo: ref.repo,
    sha: ref.sha,
    state: decision.state,
  });
}

export async function setCommitStatuses(
  octokit: GithubStatusesOctokit,
  ref: CommitStatusRef,
  decisions: CheckDecision[],
): Promise<void> {
  await Promise.all(decisions.map((decision) => setCommitStatus(octokit, ref, decision)));
}
