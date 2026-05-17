import type { Webhooks } from "@octokit/webhooks";

const pullRequestActions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export function registerGithubHandlers(webhooks: Webhooks): void {
  webhooks.on("pull_request", async ({ name, payload }) => {
    if (!pullRequestActions.has(payload.action)) {
      return;
    }

    const repository = payload.repository.full_name;
    const pullNumber = payload.pull_request.number;

    console.info(
      {
        action: payload.action,
        event: name,
        pullNumber,
        repository,
      },
      "received pull request event",
    );
  });

  webhooks.on("pull_request_review", async ({ payload }) => {
    if (payload.action !== "submitted") {
      return;
    }

    console.info(
      {
        action: payload.action,
        pullNumber: payload.pull_request.number,
        repository: payload.repository.full_name,
        reviewState: payload.review.state,
      },
      "received pull request review event",
    );
  });

  webhooks.onError((error) => {
    console.error(error, "webhook processing failed");
  });
}
