import { describe, expect, it, vi } from "vitest";

import {
  buildEscalationRequirementsFromState,
  processEscalationRun,
  type EscalationWorkflowDependencies,
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
    expect(dependencies.postComment).toHaveBeenCalledWith(
      "Warn assigned reviewers for and:platform: @alice",
    );
    expect(dependencies.postComment).toHaveBeenCalledWith(
      "Notify fallback team @org/leads for and:platform: @org/leads",
    );
    expect(dependencies.requestReviewers).toHaveBeenCalledWith(["bob"]);
    expect(dependencies.upsertComment).toHaveBeenCalledWith(
      expect.stringContaining("<!-- clearance-state:v1"),
    );
    expect(result.sideEffectFailures).toEqual([]);
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
    expect(dependencies.postComment).not.toHaveBeenCalled();
    expect(dependencies.requestReviewers).not.toHaveBeenCalled();
    expect(dependencies.upsertComment).toHaveBeenCalledTimes(1);
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
    expect(dependencies.upsertComment).toHaveBeenCalledWith(
      expect.stringContaining("Dry run mode is active."),
    );
    expect(dependencies.postComment).not.toHaveBeenCalled();
    expect(dependencies.requestReviewers).not.toHaveBeenCalled();
  });

  it("returns side effect failures instead of throwing", async () => {
    const dependencies = createDependencies();
    dependencies.postComment = vi.fn<EscalationWorkflowDependencies["postComment"]>(async () => {
      throw new Error("comment unavailable");
    });

    const result = await processEscalationRun(
      {
        now: "2026-05-17T12:00:00.000Z",
        requirements: [
          {
            assignedReviewers: ["alice"],
            eligibleReviewers: ["alice"],
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

    expect(result.sideEffectFailures).toEqual([
      {
        message: "comment unavailable",
        operation: "post-comment",
      },
    ]);
    expect(dependencies.upsertComment).toHaveBeenCalled();
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

function createDependencies(): EscalationWorkflowDependencies {
  return {
    postComment: vi.fn<EscalationWorkflowDependencies["postComment"]>(async () => {}),
    requestReviewers: vi.fn<EscalationWorkflowDependencies["requestReviewers"]>(async () => {}),
    saveState: vi.fn<EscalationWorkflowDependencies["saveState"]>(async () => {}),
    upsertComment: vi.fn<EscalationWorkflowDependencies["upsertComment"]>(async () => {}),
  };
}
