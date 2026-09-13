import type { DrizzleClearanceStore, PullRequestStateRef } from "../db/index.js";
import type { ReviewTransition } from "../workflow/transition.js";
import { githubOutboxJobTypes, type GithubOutboxJobInput } from "./outbox.js";

export type GithubReviewTransitionStore = Pick<DrizzleClearanceStore, "savePullRequestTransition">;

/** Accept the state and GitHub work together; remote execution belongs to the outbox runner. */
export async function commitGithubReviewTransition(
  store: GithubReviewTransitionStore,
  input: PullRequestStateRef,
  installationId: number,
  transition: ReviewTransition,
): Promise<void> {
  const base = { installationId, owner: input.owner, repo: input.repo };
  const pull = { ...base, pullNumber: input.pullNumber };
  const jobs = transition.effects.map((effect): GithubOutboxJobInput => {
    switch (effect.type) {
      case "upsert-comment":
        return {
          type: githubOutboxJobTypes.upsertComment,
          payload: { ...pull, body: effect.body },
        };
      case "post-comment":
        return { type: githubOutboxJobTypes.postComment, payload: { ...pull, body: effect.body } };
      case "request-reviewers":
        return {
          type: githubOutboxJobTypes.requestReviewers,
          payload: { ...pull, reviewers: effect.reviewers },
        };
      case "set-statuses":
        return {
          type: githubOutboxJobTypes.setStatuses,
          payload: { ...base, sha: input.headSha, decisions: effect.decisions },
        };
      case "send-notifications":
        return {
          type: githubOutboxJobTypes.sendNotifications,
          payload: { ...pull, notifications: effect.notifications },
        };
    }
  });
  await store.savePullRequestTransition(input, transition.state, jobs);
}
