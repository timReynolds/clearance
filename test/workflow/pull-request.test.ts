import { describe, expect, it, vi } from "vitest";

import type { GithubIdentityResolution } from "../../src/github/index.js";
import { parseOwnersToml, type OwnershipTree } from "../../src/owners/index.js";
import { createEmptyClearanceState, renderClearanceComment } from "../../src/state/index.js";
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
        identity: "and:.:@org/platform:1",
        relevantFiles: ["src/index.ts"],
        status: "pending",
      }),
    ]);
    expect(dependencies.upsertComment).toHaveBeenCalledWith(
      expect.objectContaining({ pullNumber: 42 }),
      expect.stringContaining("<!-- clearance-state:v1"),
    );
    expect(dependencies.setStatuses).toHaveBeenCalledWith(input(), result.checks);
    expect(dependencies.requestReviewers).toHaveBeenCalledWith(input(), ["alice"]);
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
  identityResolution: GithubIdentityResolution;
  ownershipTree: OwnershipTree;
}): PullRequestWorkflowDependencies & { upsertedBody?: string } {
  const dependencies: PullRequestWorkflowDependencies & { upsertedBody?: string } = {
    findStickyComment: vi.fn<PullRequestWorkflowDependencies["findStickyComment"]>(async () =>
      options.existingComment === undefined ? undefined : { body: options.existingComment },
    ),
    listChangedFiles: vi.fn<PullRequestWorkflowDependencies["listChangedFiles"]>(
      async () => options.changedFiles,
    ),
    loadOwnershipTree: vi.fn<PullRequestWorkflowDependencies["loadOwnershipTree"]>(
      async () => options.ownershipTree,
    ),
    requestReviewers: vi.fn<PullRequestWorkflowDependencies["requestReviewers"]>(async () => {}),
    resolveIdentities: vi.fn<PullRequestWorkflowDependencies["resolveIdentities"]>(
      async () => options.identityResolution,
    ),
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

function identityResolution(): GithubIdentityResolution {
  return {
    candidateReviewersByTeam: new Map([
      [
        "@org/platform",
        [
          {
            id: 1,
            login: "alice",
          },
        ],
      ],
    ]),
    diagnostics: [],
    teams: new Map([
      [
        "@org/platform",
        {
          actor: "@org/platform",
          id: 1,
          members: [
            {
              id: 1,
              login: "alice",
            },
          ],
          name: "Platform",
          org: "org",
          slug: "platform",
          type: "team",
        },
      ],
    ]),
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
