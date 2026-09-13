import { describe, expect, it, vi } from "vitest";

import {
  buildEscalationRequirementsFromState,
  processEscalationRun,
  type EscalationWorkflowDependencies,
  type ReviewTransitionEffect,
} from "../../src/workflow/index.js";
import { createEmptyClearanceState } from "../../src/state/index.js";

describe("processEscalationRun", () => {
  it("posts warnings, requests reviewers, records fallback notifications, and updates persisted state", async () => {
    const dependencies = createDependencies();

    const result = await processEscalationRun(
      {
        now: "2026-05-17T12:00:00.000Z",
        requirements: [
          {
            assignedReviewers: ["alice"],
            eligibleReviewers: ["alice", "bob"],
            escalateAfter: "2h",
            fallbackAfter: "4h",
            fallbackTeam: "@org/leads",
            identity: "and:platform",
            pendingSince: "2026-05-17T07:00:00.000Z",
            status: "pending",
            warnAfter: "1h",
          },
        ],
        state: createEmptyClearanceState(),
      },
      dependencies,
    );

    expect(result.actions.map((action) => action.type)).toEqual([
      "warn",
      "request_reviewer",
      "fallback",
    ]);
    expect(result.state.escalations).toEqual([
      expect.objectContaining({
        requirementIdentity: "and:platform",
        type: "warning",
      }),
      expect.objectContaining({
        actor: "bob",
        requirementIdentity: "and:platform",
        type: "escalation",
      }),
    ]);
    expect(result.state.fallbackNotifications).toEqual([
      expect.objectContaining({
        actor: "@org/leads",
        requirementIdentity: "and:platform",
        type: "fallback",
      }),
    ]);
    expect(dependencies.effects).toContainEqual({
      type: "post-comment",
      body: "Warn assigned reviewers for and:platform: @alice",
    });
    expect(dependencies.effects).toContainEqual({
      type: "post-comment",
      body: "Notify fallback team @org/leads for and:platform: @org/leads",
    });
    expect(dependencies.effects).toContainEqual({ type: "request-reviewers", reviewers: ["bob"] });
    expect(dependencies.effects).toContainEqual({
      type: "upsert-comment",
      body: expect.stringContaining("<!-- clearance-state:v1"),
    });
  });

  it("does nothing when no escalation actions are due", async () => {
    const dependencies = createDependencies();

    const result = await processEscalationRun(
      {
        now: "2026-05-17T12:00:00.000Z",
        requirements: [
          {
            assignedReviewers: ["alice"],
            eligibleReviewers: ["alice", "bob"],
            identity: "and:platform",
            pendingSince: "2026-05-17T11:30:00.000Z",
            status: "pending",
            warnAfter: "1h",
          },
        ],
        state: {
          ...createEmptyClearanceState(),
          dryRun: true,
        },
      },
      dependencies,
    );

    expect(result.actions).toEqual([]);
    expect(dependencies.effects.some((effect) => effect.type === "post-comment")).toBe(false);
    expect(dependencies.effects.some((effect) => effect.type === "request-reviewers")).toBe(false);
    expect(dependencies.effects.filter((effect) => effect.type === "upsert-comment")).toHaveLength(
      1,
    );
  });

  it("updates only the sticky comment in dry-run mode", async () => {
    const dependencies = createDependencies();

    const result = await processEscalationRun(
      {
        now: "2026-05-17T12:00:00.000Z",
        requirements: [
          {
            assignedReviewers: ["alice"],
            eligibleReviewers: ["alice", "bob"],
            escalateAfter: "2h",
            identity: "and:platform",
            pendingSince: "2026-05-17T07:00:00.000Z",
            status: "pending",
            warnAfter: "1h",
          },
        ],
        state: {
          ...createEmptyClearanceState(),
          dryRun: true,
        },
      },
      dependencies,
    );

    expect(result.actions).toEqual([]);
    expect(result.state.escalations).toEqual([]);
    expect(dependencies.effects).toContainEqual({
      type: "upsert-comment",
      body: expect.stringContaining("Dry run mode is active."),
    });
    expect(dependencies.effects.some((effect) => effect.type === "post-comment")).toBe(false);
    expect(dependencies.effects.some((effect) => effect.type === "request-reviewers")).toBe(false);
  });

  it("builds escalation requirements from persisted state", () => {
    const requirements = buildEscalationRequirementsFromState(
      {
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
            eligibleReviewers: ["alice", "bob"],
            escalateAfter: "2h",
            fallbackAfter: "4h",
            fallbackTeam: "@org/leads",
            identity: "and:platform",
            label: "Platform",
            requiredCount: 1,
            resetOnPush: true,
            status: "pending",
            type: "and",
            updatedAt: "2026-05-17T11:00:00.000Z",
            warnAfter: "1h",
          },
          {
            approvedBy: ["carol"],
            identity: "and:security",
            label: "Security",
            requiredCount: 1,
            status: "approved",
            type: "and",
          },
        ],
      },
      "2026-05-17T12:00:00.000Z",
    );

    expect(requirements).toEqual([
      {
        assignedReviewers: ["alice"],
        eligibleReviewers: ["alice", "bob"],
        escalateAfter: "2h",
        fallbackAfter: "4h",
        fallbackTeam: "@org/leads",
        identity: "and:platform",
        pendingSince: "2026-05-17T07:00:00.000Z",
        resetOnPush: true,
        status: "pending",
        updatedAt: "2026-05-17T11:00:00.000Z",
        warnAfter: "1h",
      },
    ]);
  });
});

function createDependencies(): EscalationWorkflowDependencies & {
  effects: ReviewTransitionEffect[];
} {
  const dependencies: EscalationWorkflowDependencies & { effects: ReviewTransitionEffect[] } = {
    effects: [],
    commitTransition: vi.fn<EscalationWorkflowDependencies["commitTransition"]>(
      async (transition) => {
        dependencies.effects = transition.effects;
      },
    ),
  };
  return dependencies;
}
