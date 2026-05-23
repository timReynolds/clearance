import { describe, expect, it, vi } from "vitest";

import type { GithubIdentityResolution } from "../../src/github/index.js";
import { parseOwnersToml, type OwnershipTree } from "../../src/owners/index.js";
import {
  createEmptyClearanceState,
  parseClearanceState,
  renderClearanceComment,
  type ClearanceState,
} from "../../src/state/index.js";
import {
  processPullRequestChange,
  processSubmittedReview,
  type PullRequestWorkflowDependencies,
  type PullRequestWorkflowInput,
} from "../../src/workflow/index.js";

describe("pull request workflow", () => {
  it("processes pull request changes with comments, checks, and reviewer requests", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });

    const result = await processPullRequestChange(input(), dependencies);

    expect(result.requestedReviewers).toEqual(["alice"]);
    expect(result.checks).toEqual([
      {
        context: "clearance/config",
        description: "OWNERS.toml configuration is valid",
        state: "success",
      },
      {
        context: "clearance/review",
        description: "1 review requirement pending",
        state: "pending",
      },
    ]);
    expect(result.state.requirements).toEqual([
      expect.objectContaining({
        approvedBy: [],
        assignedReviewers: ["alice"],
        eligibleReviewers: ["alice"],
        identity: "and:.:@org/platform:1",
        pendingSince: "2026-05-17T12:00:00.000Z",
        relevantFiles: ["src/index.ts"],
        status: "pending",
      }),
    ]);
    expect(result.state.assignments).toEqual([
      {
        assignedAt: "2026-05-17T12:00:00.000Z",
        requirementIdentity: "and:.:@org/platform:1",
        reviewers: ["alice"],
      },
    ]);
    expect(dependencies.upsertComment).toHaveBeenCalledWith(
      expect.objectContaining({ pullNumber: 42 }),
      expect.stringContaining("<!-- clearance-state:v1"),
    );
    expect(dependencies.setStatuses).toHaveBeenCalledWith(input(), result.checks);
    expect(dependencies.requestReviewers).toHaveBeenCalledWith(input(), ["alice"]);
  });

  it("renders the comment only in dry-run mode", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts", "docs/readme.md"],
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
dry_run = true

[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]

[[notify]]
paths = ["docs/**"]
users = ["@alice"]
`),
    });

    const result = await processPullRequestChange(input(), dependencies);

    expect(result.requestedReviewers).toEqual([]);
    expect(result.checks[1]).toEqual({
      context: "clearance/review",
      description: "1 review requirement pending",
      state: "pending",
    });
    expect(result.state.assignments).toEqual([]);
    expect(result.state.requirements[0]?.assignedReviewers).toEqual(["alice"]);
    expect(result.state.notificationsSent).toEqual([]);
    expect(dependencies.upsertComment).toHaveBeenCalledWith(
      input(),
      expect.stringContaining("Dry run mode is active."),
    );
    expect(dependencies.setStatuses).not.toHaveBeenCalled();
    expect(dependencies.requestReviewers).not.toHaveBeenCalled();
    expect(dependencies.sendNotifications).not.toHaveBeenCalled();

    const enforcingDependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: dependencies.upsertedBody,
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });

    const enforcingResult = await processPullRequestChange(input(), enforcingDependencies);

    expect(enforcingResult.requestedReviewers).toEqual(["alice"]);
    expect(enforcingDependencies.requestReviewers).toHaveBeenCalledWith(input(), ["alice"]);
  });

  it("uses reviewer signals before assigning reviewers", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      identityResolution: identityResolution({
        members: ["alice", "bob"],
      }),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });
    dependencies.listReviewerSignals = vi.fn<
      PullRequestWorkflowDependencies["listReviewerSignals"]
    >(async () => [
      {
        blameCoverage: 0.1,
        currentLoad: 5,
        login: "alice",
        reviewHistory: 0.1,
        roundRobinRank: 1,
      },
      {
        blameCoverage: 1,
        currentLoad: 0,
        login: "bob",
        reviewHistory: 1,
        roundRobinRank: 0,
      },
    ]);

    const result = await processPullRequestChange(input(), dependencies);

    expect(dependencies.listReviewerSignals).toHaveBeenCalledWith(
      input(),
      ["alice", "bob"],
      ["src/index.ts"],
    );
    expect(result.requestedReviewers).toEqual(["bob"]);
  });

  it("requests reviewers only for newly introduced requirements", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: renderClearanceComment({
        ...createEmptyClearanceState(),
        assignments: [
          {
            assignedAt: "2026-05-17T10:00:00.000Z",
            requirementIdentity: "and:.:@org/platform:1",
            reviewers: ["alice"],
          },
        ],
      }),
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });

    const result = await processPullRequestChange(input(), dependencies);

    expect(result.requestedReviewers).toEqual([]);
    expect(result.state.assignments).toEqual([
      {
        assignedAt: "2026-05-17T10:00:00.000Z",
        requirementIdentity: "and:.:@org/platform:1",
        reviewers: ["alice"],
      },
    ]);
    expect(dependencies.requestReviewers).toHaveBeenCalledWith(input(), []);
  });

  it("loads previous state from persistence", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingState: {
        ...createEmptyClearanceState(),
        assignments: [
          {
            assignedAt: "2026-05-17T10:00:00.000Z",
            requirementIdentity: "and:.:@org/platform:1",
            reviewers: ["alice"],
          },
        ],
      },
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });

    const result = await processPullRequestChange(input(), dependencies);

    expect(dependencies.loadState).toHaveBeenCalledWith(input());
    expect(result.requestedReviewers).toEqual([]);
    expect(result.state.assignments[0]?.assignedAt).toBe("2026-05-17T10:00:00.000Z");
    expect(dependencies.saveState).toHaveBeenCalledWith(input(), result.state);
  });

  it("sends new notifications once and records them in sticky state", async () => {
    const dependencies = createDependencies({
      changedFiles: ["docs/readme.md"],
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[notify]]
paths = ["docs/**"]
teams = ["@org/docs"]
users = ["@alice"]
`),
    });

    const result = await processPullRequestChange(input(), dependencies);

    expect(result.state.notificationsSent).toEqual(["notify:.:teams=@org/docs:users=@alice"]);
    expect(dependencies.sendNotifications).toHaveBeenCalledWith(input(), [
      expect.objectContaining({
        identity: "notify:.:teams=@org/docs:users=@alice",
        teams: ["@org/docs"],
        users: ["@alice"],
      }),
    ]);

    const repeatedDependencies = createDependencies({
      changedFiles: ["docs/readme.md"],
      existingComment: dependencies.upsertedBody,
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[notify]]
paths = ["docs/**"]
teams = ["@org/docs"]
users = ["@alice"]
`),
    });

    const repeatedResult = await processPullRequestChange(input(), repeatedDependencies);

    expect(repeatedResult.state.notificationsSent).toEqual([
      "notify:.:teams=@org/docs:users=@alice",
    ]);
    expect(repeatedDependencies.sendNotifications).toHaveBeenCalledWith(input(), []);
  });

  it("stores escalation policy metadata on review requirements", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
escalation = { warn_after = "30m", escalate_after = "1h", fallback_after = "2h", fallback_team = "@org/leads", reset_on_push = true }
`),
    });

    const result = await processPullRequestChange(input(), dependencies);

    expect(result.state.requirements[0]).toEqual(
      expect.objectContaining({
        escalateAfter: "1h",
        fallbackAfter: "2h",
        fallbackTeam: "@org/leads",
        resetOnPush: true,
        warnAfter: "30m",
      }),
    );
  });

  it("records submitted approvals and updates review checks", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });
    const opened = await processPullRequestChange(input(), dependencies);
    const reviewDependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: dependencies.upsertedBody ?? "",
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });

    const result = await processSubmittedReview(
      {
        ...input(),
        reviewState: "approved",
        reviewer: "alice",
      },
      reviewDependencies,
    );

    expect(opened.state.requirements[0]?.status).toBe("pending");
    expect(result.state.requirements[0]).toEqual(
      expect.objectContaining({
        approvedBy: ["alice"],
        approvedHeadSha: "head-sha",
        status: "approved",
      }),
    );
    expect(result.checks[1]).toEqual({
      context: "clearance/review",
      description: "All review requirements are satisfied",
      state: "success",
    });
    expect(reviewDependencies.requestReviewers).not.toHaveBeenCalled();
  });

  it("revokes submitted approvals when a reviewer requests changes", async () => {
    const reviewDependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: approvedComment("head-sha"),
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });

    const result = await processSubmittedReview(
      {
        ...input(),
        reviewState: "changes_requested",
        reviewer: "alice",
      },
      reviewDependencies,
    );

    expect(result.state.approvals).toEqual([]);
    expect(result.state.requirements[0]).toEqual(
      expect.objectContaining({
        approvedBy: [],
        status: "pending",
      }),
    );
    expect(result.checks[1]).toEqual({
      context: "clearance/review",
      description: "1 review requirement pending",
      state: "pending",
    });
  });

  it("updates the comment only for submitted reviews in dry-run mode", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: approvedComment("head-sha"),
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
dry_run = true

[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });

    const result = await processSubmittedReview(
      {
        ...input(),
        reviewState: "approved",
        reviewer: "alice",
      },
      dependencies,
    );

    expect(result.checks[1]?.state).toBe("success");
    expect(dependencies.upsertComment).toHaveBeenCalledWith(
      expect.objectContaining({ pullNumber: 42 }),
      expect.stringContaining("Dry run mode is active."),
    );
    expect(dependencies.setStatuses).not.toHaveBeenCalled();
    expect(dependencies.requestReviewers).not.toHaveBeenCalled();

    const enforcingDependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: dependencies.upsertedBody,
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });

    const enforcingResult = await processPullRequestChange(input(), enforcingDependencies);

    expect(enforcingResult.requestedReviewers).toEqual([]);
    expect(enforcingDependencies.requestReviewers).toHaveBeenCalledWith(input(), []);
  });

  it("sets failing checks and skips reviewer requests for invalid config", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      identityResolution: {
        candidateReviewersByTeam: new Map(),
        diagnostics: [],
        teams: new Map(),
        users: new Map(),
      },
      ownershipTree: {
        diagnostics: [
          {
            filePath: "OWNERS.toml",
            message: "bad config",
            schemaPath: "$.rule[0]",
            severity: "error",
          },
        ],
        files: [],
        truncated: false,
      },
    });

    const result = await processPullRequestChange(input(), dependencies);

    expect(result.requestedReviewers).toEqual([]);
    expect(result.state.warnings).toEqual([
      {
        message: "OWNERS.toml $.rule[0]: bad config",
      },
    ]);
    expect(result.checks).toEqual([
      {
        context: "clearance/config",
        description: "1 OWNERS.toml validation error",
        state: "failure",
      },
      {
        context: "clearance/review",
        description: "OWNERS.toml $.rule[0]: bad config",
        state: "failure",
      },
    ]);
  });

  it("activates and retains authorized comment overrides until revoked", async () => {
    const owners = `
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]

[override]
teams = ["@org/admins"]
`;
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      identityResolution: identityResolution({
        teams: {
          "@org/admins": ["admin"],
          "@org/platform": ["alice"],
        },
      }),
      ownershipTree: ownershipTree(owners),
    });

    const activated = await processPullRequestChange(
      {
        ...input(),
        overrideCommand: { commentId: 123, type: "activate" },
        sender: "admin",
      },
      dependencies,
    );

    expect(activated.state.override).toEqual({
      actor: "admin",
      at: "2026-05-17T12:00:00.000Z",
      commentId: 123,
    });
    expect(activated.checks[1]).toEqual({
      context: "clearance/review",
      description: "Review clearance granted by authorized override",
      state: "success",
    });
    expect(activated.requestedReviewers).toEqual([]);

    const retainedDependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: dependencies.upsertedBody,
      identityResolution: identityResolution({
        teams: {
          "@org/admins": ["admin"],
          "@org/platform": ["alice"],
        },
      }),
      ownershipTree: ownershipTree(owners),
    });
    const retained = await processPullRequestChange(input(), retainedDependencies);

    expect(retained.state.override).toEqual(activated.state.override);
    expect(retained.checks[1]?.state).toBe("success");

    const revokedDependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: retainedDependencies.upsertedBody,
      identityResolution: identityResolution({
        teams: {
          "@org/admins": ["admin"],
          "@org/platform": ["alice"],
        },
      }),
      ownershipTree: ownershipTree(owners),
    });
    const revoked = await processPullRequestChange(
      {
        ...input(),
        overrideCommand: { commentId: 124, type: "revoke" },
        sender: "admin",
      },
      revokedDependencies,
    );

    expect(revoked.state.override).toBeUndefined();
    expect(revoked.checks[1]).toEqual({
      context: "clearance/review",
      description: "1 review requirement pending",
      state: "pending",
    });
  });

  it("returns side effect failures instead of throwing", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });
    dependencies.requestReviewers = vi.fn<PullRequestWorkflowDependencies["requestReviewers"]>(
      async () => {
        throw new Error("reviewer API unavailable");
      },
    );

    const result = await processPullRequestChange(input(), dependencies);

    expect(result.sideEffectFailures).toEqual([
      {
        message: "reviewer API unavailable",
        operation: "request-reviewers",
      },
    ]);
    expect(result.requestedReviewers).toEqual(["alice"]);
    expect(dependencies.upsertComment).toHaveBeenCalled();
    expect(dependencies.setStatuses).toHaveBeenCalled();
  });

  it("returns submitted-review side effect failures instead of throwing", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: approvedComment("head-sha"),
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });
    dependencies.setStatuses = vi.fn<PullRequestWorkflowDependencies["setStatuses"]>(async () => {
      throw new Error("status API unavailable");
    });

    const result = await processSubmittedReview(
      {
        ...input(),
        reviewState: "approved",
        reviewer: "alice",
      },
      dependencies,
    );

    expect(result.sideEffectFailures).toEqual([
      {
        message: "status API unavailable",
        operation: "set-statuses",
      },
    ]);
    expect(dependencies.upsertComment).toHaveBeenCalled();
    expect(dependencies.requestReviewers).not.toHaveBeenCalled();
  });

  it("fails review checks when an OR requirement has no eligible reviewers", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      identityResolution: {
        candidateReviewersByTeam: new Map(),
        diagnostics: [],
        teams: new Map([
          [
            "@org/platform",
            {
              actor: "@org/platform",
              members: [],
              org: "org",
              slug: "platform",
              type: "team",
            },
          ],
          [
            "@org/security",
            {
              actor: "@org/security",
              members: [],
              org: "org",
              slug: "security",
              type: "team",
            },
          ],
        ]),
        users: new Map(),
      },
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require_any = [
  { from = "@org/platform", count = 1 },
  { from = "@org/security", count = 1 },
]
`),
    });

    const result = await processPullRequestChange(input(), dependencies);

    expect(result.requestedReviewers).toEqual([]);
    expect(result.checks[1]).toEqual({
      context: "clearance/review",
      description: "Requirement or:.:@org/platform:1|@org/security:1 has no eligible reviewers",
      state: "failure",
    });
  });

  it("allows any require_any option to satisfy an OR requirement, not just the assigned option", async () => {
    const owners = `
[[rule]]
paths = ["src/**"]
require_any = [
  { from = "@org/security", count = 1 },
  { from = "@org/compliance", count = 1 },
]
`;
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      identityResolution: identityResolution({
        teams: {
          "@org/compliance": ["compliance-reviewer"],
          "@org/security": ["security-reviewer"],
        },
      }),
      ownershipTree: ownershipTree(owners),
    });
    dependencies.listReviewerSignals = vi.fn<
      PullRequestWorkflowDependencies["listReviewerSignals"]
    >(async () => [
      {
        blameCoverage: 1,
        login: "security-reviewer",
      },
      {
        blameCoverage: 0,
        login: "compliance-reviewer",
      },
    ]);
    await processPullRequestChange(input(), dependencies);
    expect(dependencies.requestReviewers).toHaveBeenCalledWith(input(), ["security-reviewer"]);

    const reviewDependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: dependencies.upsertedBody ?? "",
      identityResolution: identityResolution({
        teams: {
          "@org/compliance": ["compliance-reviewer"],
          "@org/security": ["security-reviewer"],
        },
      }),
      ownershipTree: ownershipTree(owners),
    });

    const result = await processSubmittedReview(
      {
        ...input(),
        reviewState: "approved",
        reviewer: "compliance-reviewer",
      },
      reviewDependencies,
    );

    expect(result.state.requirements[0]).toEqual(
      expect.objectContaining({
        approvedBy: ["compliance-reviewer"],
        status: "approved",
      }),
    );
    expect(result.checks[1]).toEqual({
      context: "clearance/review",
      description: "All review requirements are satisfied",
      state: "success",
    });
  });

  it("supports multiple independent require_any groups in one matching rule", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      identityResolution: identityResolution({
        teams: {
          "@org/compliance": ["compliance-reviewer"],
          "@org/ml-platform": ["ml-reviewer"],
          "@org/platform": ["platform-reviewer"],
          "@org/security": ["security-reviewer"],
        },
      }),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require_any = [
  [
    { from = "@org/security", count = 1 },
    { from = "@org/compliance", count = 1 },
  ],
  [
    { from = "@org/platform", count = 1 },
    { from = "@org/ml-platform", count = 1 },
  ],
]
`),
    });

    const result = await processPullRequestChange(input(), dependencies);

    expect(result.state.requirements.map((requirement) => requirement.identity)).toEqual([
      "or:.:@org/compliance:1|@org/security:1",
      "or:.:@org/ml-platform:1|@org/platform:1",
    ]);
    expect(result.checks[1]).toEqual({
      context: "clearance/review",
      description: "2 review requirements pending",
      state: "pending",
    });
    expect(result.requestedReviewers).toEqual(["compliance-reviewer", "ml-reviewer"]);
  });

  it("retains prior approvals on synchronize when changed files are irrelevant", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: approvedComment("head-1"),
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });

    const result = await processPullRequestChange(
      {
        ...input(),
        changedFilesSinceLastApproval: ["docs/readme.md"],
        headSha: "head-2",
      },
      dependencies,
    );

    expect(result.state.requirements[0]).toEqual(
      expect.objectContaining({
        approvedBy: ["alice"],
        approvedHeadSha: "head-1",
        status: "approved",
      }),
    );
    expect(result.checks[1]).toEqual({
      context: "clearance/review",
      description: "All review requirements are satisfied",
      state: "success",
    });
  });

  it("invalidates prior approvals on synchronize when relevant files changed", async () => {
    const dependencies = createDependencies({
      changedFiles: ["src/index.ts"],
      existingComment: approvedComment("head-1"),
      identityResolution: identityResolution(),
      ownershipTree: ownershipTree(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`),
    });

    const result = await processPullRequestChange(
      {
        ...input(),
        changedFilesSinceLastApproval: ["src/index.ts"],
        headSha: "head-2",
      },
      dependencies,
    );

    expect(result.state.requirements[0]).toEqual(
      expect.objectContaining({
        approvedBy: [],
        approvedHeadSha: undefined,
        status: "pending",
      }),
    );
    expect(result.checks[1]?.state).toBe("pending");
  });
});

function input(): PullRequestWorkflowInput {
  return {
    author: "author",
    headSha: "head-sha",
    labels: [],
    now: "2026-05-17T12:00:00.000Z",
    owner: "acme",
    pullNumber: 42,
    repo: "clearance",
    sender: "author",
  };
}

function createDependencies(options: {
  changedFiles: string[];
  existingComment?: string;
  existingState?: ClearanceState;
  identityResolution: GithubIdentityResolution;
  ownershipTree: OwnershipTree;
}): PullRequestWorkflowDependencies & { savedState?: ClearanceState; upsertedBody?: string } {
  let storedState =
    options.existingState ??
    (options.existingComment === undefined
      ? undefined
      : parseClearanceState(options.existingComment).state);
  const dependencies: PullRequestWorkflowDependencies & {
    savedState?: ClearanceState;
    upsertedBody?: string;
  } = {
    listChangedFiles: vi.fn<PullRequestWorkflowDependencies["listChangedFiles"]>(
      async () => options.changedFiles,
    ),
    listReviewerSignals: vi.fn<PullRequestWorkflowDependencies["listReviewerSignals"]>(
      async () => [],
    ),
    loadState: vi.fn<PullRequestWorkflowDependencies["loadState"]>(async () => storedState),
    loadOwnershipTree: vi.fn<PullRequestWorkflowDependencies["loadOwnershipTree"]>(
      async () => options.ownershipTree,
    ),
    requestReviewers: vi.fn<PullRequestWorkflowDependencies["requestReviewers"]>(async () => {}),
    resolveIdentities: vi.fn<PullRequestWorkflowDependencies["resolveIdentities"]>(
      async () => options.identityResolution,
    ),
    saveState: vi.fn<PullRequestWorkflowDependencies["saveState"]>(async (_input, state) => {
      storedState = state;
      dependencies.savedState = state;
    }),
    sendNotifications: vi.fn<PullRequestWorkflowDependencies["sendNotifications"]>(async () => {}),
    setStatuses: vi.fn<PullRequestWorkflowDependencies["setStatuses"]>(async () => {}),
    upsertComment: vi.fn<PullRequestWorkflowDependencies["upsertComment"]>(async (_input, body) => {
      dependencies.upsertedBody = body;
    }),
  };

  return dependencies;
}

function ownershipTree(source: string): OwnershipTree {
  const result = parseOwnersToml(source);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }

  return {
    diagnostics: [],
    files: [
      {
        config: result.config,
        diagnostics: [],
        directory: ".",
        path: "OWNERS.toml",
        sha: "sha",
      },
    ],
    truncated: false,
  };
}

function identityResolution(
  options: { members?: string[]; teams?: Record<string, string[]> } = {},
): GithubIdentityResolution {
  const membersByTeam = {
    "@org/platform": options.members ?? ["alice"],
    ...options.teams,
  };

  return {
    candidateReviewersByTeam: new Map(
      Object.entries(membersByTeam).map(([actor, members]) => [
        actor,
        members.map((login, index) => ({
          id: index + 1,
          login,
        })),
      ]),
    ),
    diagnostics: [],
    teams: new Map(
      Object.entries(membersByTeam).map(([actor, members], teamIndex) => {
        const [org = "org", slug = "team"] = actor.slice(1).split("/");

        return [
          actor,
          {
            actor,
            id: teamIndex + 1,
            members: members.map((login, index) => ({
              id: index + 1,
              login,
            })),
            name: slug,
            org,
            slug,
            type: "team" as const,
          },
        ];
      }),
    ),
    users: new Map(),
  };
}

function approvedComment(headSha: string): string {
  return renderClearanceComment({
    ...createEmptyClearanceState(),
    approvals: [
      {
        approvedAt: "2026-05-17T11:00:00.000Z",
        headSha,
        requirementIdentity: "and:.:@org/platform:1",
        reviewer: "alice",
      },
    ],
    requirements: [
      {
        approvedBy: ["alice"],
        approvedHeadSha: headSha,
        identity: "and:.:@org/platform:1",
        label: "@org/platform approval",
        relevantFiles: ["src/index.ts"],
        requiredCount: 1,
        status: "approved",
        type: "and",
      },
    ],
  });
}
