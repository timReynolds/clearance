import { describe, expect, it } from "vitest";

import { DrizzleClearanceStore } from "../../src/db/store.js";
import { createTransactionalStore as createStore } from "../helpers/transactional-store.js";
import { createEmptyClearanceState } from "../../src/state/index.js";
import { commitGithubReviewTransition } from "../../src/github/review-transition.js";
import { parseOwnersToml } from "../../src/owners/index.js";
import {
  processPullRequestChange,
  processSubmittedReview,
  processEscalationRun,
  buildEscalationRequirementsFromState,
  type PullRequestWorkflowDependencies,
} from "../../src/workflow/index.js";

const ref = {
  author: "author",
  headSha: "head",
  labels: [],
  now: "2026-05-17T12:00:00.000Z",
  owner: "acme",
  pullNumber: 42,
  repo: "clearance",
  sender: "author",
};

describe("durable review transitions", () => {
  it("keeps assignments and notification intent retryable after a rejected outbox insert", async () => {
    const { database, store } = await createStore();
    const dependencies = workflowDependencies(store);
    await database.exec(
      "alter table clearance.outbox_jobs add constraint fail_notification check (type <> 'github.send-notifications')",
    );

    await expect(processPullRequestChange(ref, dependencies)).rejects.toThrow(/outbox_jobs/);
    expect(await store.loadPullRequestState(ref)).toBeUndefined();
    expect(await store.claimOutboxJobs(10)).toEqual([]);

    await database.exec("alter table clearance.outbox_jobs drop constraint fail_notification");
    const accepted = await processPullRequestChange(ref, dependencies);
    expect(accepted.requestedReviewers).toEqual(["alice"]);
    expect(accepted.state.notificationsSent).toHaveLength(1);
    expect(await store.loadPullRequestState(ref)).toEqual(accepted.state);
    expect((await store.claimOutboxJobs(10)).map(({ type }) => type).toSorted()).toEqual([
      "github.request-reviewers",
      "github.send-notifications",
      "github.set-statuses",
      "github.upsert-comment",
    ]);

    const repeated = await processPullRequestChange(ref, dependencies);
    expect(repeated.requestedReviewers).toEqual([]);
    expect((await store.claimOutboxJobs(10)).map(({ type }) => type).toSorted()).toEqual([
      "github.set-statuses",
      "github.upsert-comment",
    ]);
  }, 20000);

  it("rolls back an approval when its status job fails and accepts the submitted review on retry", async () => {
    const { database, store } = await createStore();
    const dependencies = workflowDependencies(store);
    const initial = await processPullRequestChange(ref, dependencies);
    await store.claimOutboxJobs(10);
    await database.exec(
      "alter table clearance.outbox_jobs add constraint fail_status check (type <> 'github.set-statuses') not valid",
    );
    const review = { ...ref, reviewState: "approved", reviewer: "alice" };

    await expect(processSubmittedReview(review, dependencies)).rejects.toThrow(/outbox_jobs/);
    expect(await store.loadPullRequestState(ref)).toEqual(initial.state);
    expect(await store.claimOutboxJobs(10)).toEqual([]);

    await database.exec("alter table clearance.outbox_jobs drop constraint fail_status");
    const accepted = await processSubmittedReview(review, dependencies);
    expect(accepted.state.requirements[0]?.status).toBe("approved");
    expect(await store.loadPullRequestState(ref)).toEqual(accepted.state);
    expect((await store.claimOutboxJobs(10)).map(({ type }) => type).toSorted()).toEqual([
      "github.set-statuses",
      "github.upsert-comment",
    ]);
  }, 20000);

  it("keeps escalation due after a rejected reviewer job and records it once on retry", async () => {
    const { database, store } = await createStore();
    const initial = {
      ...createEmptyClearanceState(),
      requirements: [
        {
          approvedBy: [],
          assignedReviewers: ["alice"],
          eligibleReviewers: ["alice", "bob"],
          identity: "and:platform",
          label: "Platform",
          pendingSince: "2026-05-17T07:00:00.000Z",
          requiredCount: 1,
          status: "pending" as const,
          type: "and" as const,
          warnAfter: "1h",
          escalateAfter: "2h",
          fallbackAfter: "4h",
          fallbackTeam: "@org/leads",
        },
      ],
    };
    await store.savePullRequestTransition(ref, initial, []);
    const run = async () => {
      const state = (await store.loadPullRequestState(ref))!;
      return processEscalationRun(
        { now: ref.now, requirements: buildEscalationRequirementsFromState(state, ref.now), state },
        {
          commitTransition: (transition) =>
            commitGithubReviewTransition(store, ref, 123, transition),
        },
      );
    };
    await database.exec(
      "alter table clearance.outbox_jobs add constraint fail_reviewer check (type <> 'github.request-reviewers')",
    );

    await expect(run()).rejects.toThrow(/outbox_jobs/);
    expect(await store.loadPullRequestState(ref)).toEqual(initial);
    expect(await store.claimOutboxJobs(10)).toEqual([]);

    await database.exec("alter table clearance.outbox_jobs drop constraint fail_reviewer");
    const accepted = await run();
    expect(accepted.actions.map(({ type }) => type)).toEqual([
      "warn",
      "request_reviewer",
      "fallback",
    ]);
    expect(await store.loadPullRequestState(ref)).toEqual(accepted.state);
    expect((await store.claimOutboxJobs(10)).map(({ type }) => type).toSorted()).toEqual([
      "github.post-comment",
      "github.post-comment",
      "github.request-reviewers",
      "github.upsert-comment",
    ]);
    expect((await run()).actions).toEqual([]);
    expect((await store.claimOutboxJobs(10)).map(({ type }) => type)).toEqual([
      "github.upsert-comment",
    ]);
  }, 20000);
});

function workflowDependencies(store: DrizzleClearanceStore): PullRequestWorkflowDependencies {
  const parsed = parseOwnersToml(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@alice", count = 1 }]
[[notify]]
paths = ["src/**"]
users = ["@alice"]
`);
  if (!parsed.ok) throw new Error("invalid test ownership config");
  return {
    listChangedFiles: async () => ["src/index.ts"],
    listReviewerSignals: async () => [],
    loadState: (input) => store.loadPullRequestState(input),
    loadOwnershipTree: async () => ({
      diagnostics: [],
      truncated: false,
      files: [
        {
          config: parsed.config,
          diagnostics: [],
          directory: ".",
          path: "OWNERS.toml",
          sha: "owners",
        },
      ],
    }),
    resolveIdentities: async () => ({
      candidateReviewersByTeam: new Map(),
      diagnostics: [],
      teams: new Map(),
      users: new Map([["@alice", { actor: "@alice", id: 1, login: "alice", type: "user" }]]),
    }),
    commitTransition: (input, transition) =>
      commitGithubReviewTransition(store, input, 123, transition),
  };
}
