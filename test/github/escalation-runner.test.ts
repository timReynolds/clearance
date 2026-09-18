import { describe, expect, it, vi } from "vitest";

import {
  runGithubEscalationSweep,
  type GithubEscalationRunnerOctokit,
  type GithubEscalationRunnerStateStore,
} from "../../src/github/index.js";
import { createEmptyClearanceState, type ClearanceState } from "../../src/state/index.js";

type ListPulls = GithubEscalationRunnerOctokit["rest"]["pulls"]["list"];

describe("runGithubEscalationSweep", () => {
  it("processes open pull requests with stored Clearance state", async () => {
    const octokit = createEscalationRunnerOctokit();
    const stateStore = createStateStore({
      ...createEmptyClearanceState(),
      assignments: [
        {
          assignedAt: "2026-05-17T07:00:00.000Z",
          requirementIdentity: "and:platform",
          reviewers: ["alice"],
        },
      ],
      requirements: [
        {
          approvedBy: [],
          assignedReviewers: ["alice"],
          eligibleReviewers: ["alice", "bob"],
          escalateAfter: "2h",
          identity: "and:platform",
          label: "Platform",
          pendingSince: "2026-05-17T07:00:00.000Z",
          requiredCount: 1,
          status: "pending",
          type: "and",
          warnAfter: "1h",
        },
      ],
    });

    const result = await runGithubEscalationSweep(
      octokit,
      {
        owner: "acme",
        repo: "clearance",
      },
      "2026-05-17T12:00:00.000Z",
      { installationId: 123, stateStore },
    );

    expect(result).toEqual({
      pullRequests: [
        {
          actions: 2,
          pullNumber: 42,
          status: "processed",
        },
      ],
      repository: "acme/clearance",
    });
    expect(stateStore.jobs).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          body: "Warn assigned reviewers for and:platform: @alice",
          pullNumber: 42,
        }),
        type: "github.post-comment",
      }),
    );
    expect(stateStore.jobs).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          reviewers: ["bob"],
        }),
        type: "github.request-reviewers",
      }),
    );
    expect(stateStore.jobs).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          body: expect.stringContaining("<!-- clearance-state:v1"),
        }),
        type: "github.upsert-comment",
      }),
    );
  });

  it("skips pull requests without stored Clearance state", async () => {
    const octokit = createEscalationRunnerOctokit();
    const stateStore = createStateStore();

    const result = await runGithubEscalationSweep(
      octokit,
      {
        owner: "acme",
        repo: "clearance",
      },
      "2026-05-17T12:00:00.000Z",
      { installationId: 123, stateStore },
    );

    expect(result.pullRequests).toEqual([
      {
        pullNumber: 42,
        reason: "missing stored Clearance state",
        status: "skipped",
      },
    ]);
    expect(stateStore.jobs).toEqual([]);
  });

  it("saves updated stored Clearance state", async () => {
    const octokit = createEscalationRunnerOctokit();
    const stateStore = createStateStore({
      ...createEmptyClearanceState(),
      requirements: [
        {
          approvedBy: [],
          assignedReviewers: ["alice"],
          eligibleReviewers: ["alice"],
          identity: "and:platform",
          label: "Platform",
          pendingSince: "2026-05-17T07:00:00.000Z",
          requiredCount: 1,
          status: "pending",
          type: "and",
          warnAfter: "1h",
        },
      ],
    });

    const result = await runGithubEscalationSweep(
      octokit,
      {
        owner: "acme",
        repo: "clearance",
      },
      "2026-05-17T12:00:00.000Z",
      { installationId: 123, stateStore },
    );

    expect(result.pullRequests).toEqual([
      {
        actions: 1,
        pullNumber: 42,
        status: "processed",
      },
    ]);
    expect(stateStore.savePullRequestTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
      }),
      expect.objectContaining({
        escalations: [
          expect.objectContaining({
            requirementIdentity: "and:platform",
            type: "warning",
          }),
        ],
      }),
      expect.any(Array),
    );
  });

  it("updates only the sticky comment in dry-run mode", async () => {
    const octokit = createEscalationRunnerOctokit();
    const stateStore = createStateStore({
      ...createEmptyClearanceState(),
      dryRun: true,
      requirements: [
        {
          approvedBy: [],
          assignedReviewers: ["alice"],
          eligibleReviewers: ["alice", "bob"],
          escalateAfter: "2h",
          identity: "and:platform",
          label: "Platform",
          pendingSince: "2026-05-17T07:00:00.000Z",
          requiredCount: 1,
          status: "pending",
          type: "and",
          warnAfter: "1h",
        },
      ],
    });

    const result = await runGithubEscalationSweep(
      octokit,
      {
        owner: "acme",
        repo: "clearance",
      },
      "2026-05-17T12:00:00.000Z",
      { installationId: 123, stateStore },
    );

    expect(result.pullRequests).toEqual([
      {
        actions: 0,
        pullNumber: 42,
        status: "processed",
      },
    ]);
    expect(stateStore.jobs).toHaveLength(1);
    expect(stateStore.jobs).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          body: expect.stringContaining("Dry run mode is active."),
        }),
        type: "github.upsert-comment",
      }),
    );
  });
});

type TestEscalationStateStore = GithubEscalationRunnerStateStore & {
  jobs: Parameters<GithubEscalationRunnerStateStore["savePullRequestTransition"]>[2];
  savedState?: ClearanceState;
};

function createStateStore(initialState?: ClearanceState): TestEscalationStateStore {
  const jobs: TestEscalationStateStore["jobs"] = [];
  let savedState = initialState;
  const store: TestEscalationStateStore = {
    jobs,
    loadPullRequestState: vi.fn<GithubEscalationRunnerStateStore["loadPullRequestState"]>(
      async () => savedState,
    ),
    savePullRequestTransition: vi.fn<GithubEscalationRunnerStateStore["savePullRequestTransition"]>(
      async (_input, state, acceptedJobs) => {
        jobs.push(...acceptedJobs);
        savedState = state;
        store.savedState = state;
      },
    ),
    savedState,
  };

  return store;
}

function createEscalationRunnerOctokit(): GithubEscalationRunnerOctokit {
  const list = vi.fn<ListPulls>(async () => ({
    data: [
      {
        head: {
          sha: "head-sha",
        },
        labels: [],
        number: 42,
        user: {
          login: "author",
        },
      },
    ],
  }));

  return {
    rest: {
      pulls: {
        list,
      },
    },
  };
}
