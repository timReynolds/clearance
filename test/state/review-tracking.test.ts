import { describe, expect, it } from "vitest";

import {
  createEmptyClearanceState,
  invalidateStaleApprovals,
  rebuildReviewState,
  recordSubmittedReview,
  type ReviewRequirementDefinition,
} from "../../src/state/index.js";

describe("review tracking", () => {
  it("rebuilds requirements while preserving approvals for the current head SHA", () => {
    const state = rebuildReviewState({
      definitions: definitions(),
      headSha: "head-2",
      previousState: {
        ...createEmptyClearanceState(),
        approvals: [
          {
            approvedAt: "2026-05-17T10:00:00.000Z",
            headSha: "head-2",
            requirementIdentity: "and:platform",
            reviewer: "alice",
          },
          {
            approvedAt: "2026-05-17T10:00:00.000Z",
            headSha: "old-head",
            requirementIdentity: "and:security",
            reviewer: "carol",
          },
        ],
      },
    });

    expect(state.assignments).toEqual([]);
    expect(state.requirements).toEqual([
      expect.objectContaining({
        approvedBy: ["alice"],
        approvedHeadSha: "head-2",
        identity: "and:platform",
        status: "approved",
      }),
      expect.objectContaining({
        approvedBy: [],
        approvedHeadSha: undefined,
        identity: "and:security",
        status: "pending",
      }),
    ]);
  });

  it("drops assignments and approvals for requirements that no longer exist", () => {
    const state = rebuildReviewState({
      definitions: [definitions()[0] as ReviewRequirementDefinition],
      headSha: "head-2",
      previousState: {
        ...createEmptyClearanceState(),
        approvals: [
          {
            approvedAt: "2026-05-17T10:00:00.000Z",
            headSha: "head-2",
            requirementIdentity: "and:platform",
            reviewer: "alice",
          },
          {
            approvedAt: "2026-05-17T10:00:00.000Z",
            headSha: "head-2",
            requirementIdentity: "and:deleted",
            reviewer: "mallory",
          },
        ],
        assignments: [
          {
            assignedAt: "2026-05-17T09:00:00.000Z",
            requirementIdentity: "and:platform",
            reviewers: ["alice"],
          },
          {
            assignedAt: "2026-05-17T09:00:00.000Z",
            requirementIdentity: "and:deleted",
            reviewers: ["mallory"],
          },
        ],
      },
    });

    expect(state.approvals.map((approval) => approval.requirementIdentity)).toEqual([
      "and:platform",
    ]);
    expect(state.assignments).toEqual([
      {
        assignedAt: "2026-05-17T09:00:00.000Z",
        requirementIdentity: "and:platform",
        reviewers: ["alice"],
      },
    ]);
  });

  it("records approvals against matching requirements at the current head SHA", () => {
    const initialState = rebuildReviewState({
      definitions: definitions(),
      headSha: "head-1",
    });

    const state = recordSubmittedReview(initialState, {
      approvedAt: "2026-05-17T10:00:00.000Z",
      definitions: definitions(),
      headSha: "head-1",
      reviewer: "carol",
      state: "approved",
    });

    expect(state.approvals).toEqual([
      {
        approvedAt: "2026-05-17T10:00:00.000Z",
        headSha: "head-1",
        requirementIdentity: "and:security",
        reviewer: "carol",
      },
    ]);
    expect(
      state.requirements.find((requirement) => requirement.identity === "and:security"),
    ).toEqual(
      expect.objectContaining({
        approvedBy: ["carol"],
        approvedHeadSha: "head-1",
        status: "approved",
      }),
    );
  });

  it("evaluates OR approval options independently", () => {
    const orDefinitions: ReviewRequirementDefinition[] = [
      {
        approvalOptions: [
          {
            eligibleReviewers: ["security-reviewer"],
            from: "@org/security",
            requiredCount: 1,
          },
          {
            eligibleReviewers: ["compliance-a", "compliance-b"],
            from: "@org/compliance",
            requiredCount: 2,
          },
        ],
        assignedReviewers: ["security-reviewer"],
        eligibleReviewers: ["compliance-a", "compliance-b", "security-reviewer"],
        identity: "or:security-or-compliance",
        label: "@org/security or @org/compliance",
        relevantFiles: ["src/index.ts"],
        requiredCount: 1,
        type: "or",
      },
    ];
    const initialState = rebuildReviewState({
      definitions: orDefinitions,
      headSha: "head-1",
    });

    const partiallyApproved = recordSubmittedReview(initialState, {
      approvedAt: "2026-05-17T10:00:00.000Z",
      definitions: orDefinitions,
      headSha: "head-1",
      reviewer: "compliance-a",
      state: "approved",
    });

    expect(partiallyApproved.requirements[0]).toEqual(
      expect.objectContaining({
        approvedBy: ["compliance-a"],
        status: "pending",
      }),
    );

    const approved = recordSubmittedReview(partiallyApproved, {
      approvedAt: "2026-05-17T10:05:00.000Z",
      definitions: orDefinitions,
      headSha: "head-1",
      reviewer: "compliance-b",
      state: "approved",
    });

    expect(approved.requirements[0]).toEqual(
      expect.objectContaining({
        approvedBy: ["compliance-a", "compliance-b"],
        approvedHeadSha: "head-1",
        status: "approved",
      }),
    );
  });

  it("replaces an earlier approval from the same reviewer and requirement", () => {
    const initialState = rebuildReviewState({
      definitions: definitions(),
      headSha: "head-1",
      previousState: {
        ...createEmptyClearanceState(),
        approvals: [
          {
            approvedAt: "2026-05-17T09:00:00.000Z",
            headSha: "old-head",
            requirementIdentity: "and:platform",
            reviewer: "alice",
          },
        ],
      },
    });

    const state = recordSubmittedReview(initialState, {
      approvedAt: "2026-05-17T10:00:00.000Z",
      definitions: definitions(),
      headSha: "head-1",
      reviewer: "alice",
      state: "approved",
    });

    expect(state.approvals).toEqual([
      {
        approvedAt: "2026-05-17T10:00:00.000Z",
        headSha: "head-1",
        requirementIdentity: "and:platform",
        reviewer: "alice",
      },
    ]);
  });

  it("ignores non-approval reviews and reviewers that do not match any requirement", () => {
    const initialState = rebuildReviewState({
      definitions: definitions(),
      headSha: "head-1",
    });

    expect(
      recordSubmittedReview(initialState, {
        approvedAt: "2026-05-17T10:00:00.000Z",
        definitions: definitions(),
        headSha: "head-1",
        reviewer: "mallory",
        state: "approved",
      }),
    ).toEqual(initialState);
    expect(
      recordSubmittedReview(initialState, {
        approvedAt: "2026-05-17T10:00:00.000Z",
        definitions: definitions(),
        headSha: "head-1",
        reviewer: "alice",
        state: "commented",
      }),
    ).toEqual(initialState);
  });

  it("removes a reviewer's approvals when they request changes or a review is dismissed", () => {
    const approvedState = rebuildReviewState({
      definitions: definitions(),
      headSha: "head-1",
      previousState: {
        ...createEmptyClearanceState(),
        approvals: [
          {
            approvedAt: "2026-05-17T10:00:00.000Z",
            headSha: "head-1",
            requirementIdentity: "and:platform",
            reviewer: "alice",
          },
          {
            approvedAt: "2026-05-17T10:05:00.000Z",
            headSha: "head-1",
            requirementIdentity: "and:security",
            reviewer: "carol",
          },
        ],
      },
    });

    const changesRequested = recordSubmittedReview(approvedState, {
      approvedAt: "2026-05-17T11:00:00.000Z",
      definitions: definitions(),
      headSha: "head-1",
      reviewer: "alice",
      state: "changes_requested",
    });

    expect(changesRequested.approvals).toEqual([
      {
        approvedAt: "2026-05-17T10:05:00.000Z",
        headSha: "head-1",
        requirementIdentity: "and:security",
        reviewer: "carol",
      },
    ]);
    expect(
      changesRequested.requirements.find((requirement) => requirement.identity === "and:platform"),
    ).toEqual(expect.objectContaining({ approvedBy: [], status: "pending" }));

    const dismissed = recordSubmittedReview(changesRequested, {
      approvedAt: "2026-05-17T11:05:00.000Z",
      definitions: definitions(),
      headSha: "head-1",
      reviewer: "carol",
      state: "dismissed",
    });

    expect(dismissed.approvals).toEqual([]);
    expect(
      dismissed.requirements.find((requirement) => requirement.identity === "and:security"),
    ).toEqual(expect.objectContaining({ approvedBy: [], status: "pending" }));
  });

  it("invalidates only approvals whose relevant files changed", () => {
    const approvedState = rebuildReviewState({
      definitions: definitions(),
      headSha: "head-1",
      previousState: {
        ...createEmptyClearanceState(),
        approvals: [
          {
            approvedAt: "2026-05-17T10:00:00.000Z",
            headSha: "head-1",
            requirementIdentity: "and:platform",
            reviewer: "alice",
          },
          {
            approvedAt: "2026-05-17T10:05:00.000Z",
            headSha: "head-1",
            requirementIdentity: "and:security",
            reviewer: "carol",
          },
        ],
        assignments: [
          {
            assignedAt: "2026-05-17T09:00:00.000Z",
            requirementIdentity: "and:platform",
            reviewers: ["alice"],
          },
          {
            assignedAt: "2026-05-17T09:00:00.000Z",
            requirementIdentity: "and:deleted",
            reviewers: ["mallory"],
          },
        ],
      },
    });

    const nextState = invalidateStaleApprovals(approvedState, {
      changedFiles: ["src/index.ts"],
      definitions: definitions(),
      headSha: "head-2",
    });

    expect(nextState.approvals).toEqual([
      {
        approvedAt: "2026-05-17T10:05:00.000Z",
        headSha: "head-1",
        requirementIdentity: "and:security",
        reviewer: "carol",
      },
    ]);
    expect(nextState.assignments.map((assignment) => assignment.requirementIdentity)).toEqual([
      "and:platform",
    ]);
    expect(nextState.requirements).toEqual([
      expect.objectContaining({
        approvedBy: [],
        identity: "and:platform",
        status: "pending",
      }),
      expect.objectContaining({
        approvedBy: ["carol"],
        approvedHeadSha: "head-1",
        identity: "and:security",
        status: "approved",
      }),
    ]);
  });

  it("preserves prior approvals when a new push does not touch relevant files", () => {
    const approvedState = rebuildReviewState({
      definitions: definitions(),
      headSha: "head-1",
      previousState: {
        ...createEmptyClearanceState(),
        approvals: [
          {
            approvedAt: "2026-05-17T10:00:00.000Z",
            headSha: "head-1",
            requirementIdentity: "and:platform",
            reviewer: "alice",
          },
        ],
      },
    });

    const nextState = invalidateStaleApprovals(approvedState, {
      changedFiles: ["docs/readme.md"],
      definitions: definitions(),
      headSha: "head-2",
    });

    expect(nextState.approvals).toEqual(approvedState.approvals);
    expect(
      nextState.requirements.find((requirement) => requirement.identity === "and:platform"),
    ).toEqual(
      expect.objectContaining({
        approvedBy: ["alice"],
        approvedHeadSha: "head-1",
        status: "approved",
      }),
    );
  });
});

function definitions(): ReviewRequirementDefinition[] {
  return [
    {
      assignedReviewers: ["alice"],
      eligibleReviewers: ["alice", "bob"],
      identity: "and:platform",
      label: "Platform",
      relevantFiles: ["src/index.ts"],
      requiredCount: 1,
      type: "and",
    },
    {
      assignedReviewers: ["carol"],
      eligibleReviewers: ["carol"],
      identity: "and:security",
      label: "Security",
      relevantFiles: ["security/policy.ts"],
      requiredCount: 1,
      type: "and",
    },
  ];
}
