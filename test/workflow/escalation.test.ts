import { describe, expect, it, vi } from "vitest";

import {
  processEscalationRun,
  type EscalationWorkflowDependencies,
} from "../../src/workflow/index.js";
import { createEmptyClearanceState, renderClearanceComment } from "../../src/state/index.js";

describe("processEscalationRun", () => {
  it("posts warnings, requests reviewers, records fallback notifications, and updates sticky state", async () => {
    const dependencies = createDependencies();

    const result = await processEscalationRun(
      {
        existingCommentBody: renderClearanceComment(createEmptyClearanceState()),
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
  });

  it("does nothing when no escalation actions are due", async () => {
    const dependencies = createDependencies();

    const result = await processEscalationRun(
      {
        existingCommentBody: renderClearanceComment(createEmptyClearanceState()),
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
      },
      dependencies,
    );

    expect(result.actions).toEqual([]);
    expect(dependencies.postComment).not.toHaveBeenCalled();
    expect(dependencies.requestReviewers).not.toHaveBeenCalled();
    expect(dependencies.upsertComment).toHaveBeenCalledTimes(1);
  });
});

function createDependencies(): EscalationWorkflowDependencies {
  return {
    postComment: vi.fn<EscalationWorkflowDependencies["postComment"]>(async () => {}),
    requestReviewers: vi.fn<EscalationWorkflowDependencies["requestReviewers"]>(async () => {}),
    upsertComment: vi.fn<EscalationWorkflowDependencies["upsertComment"]>(async () => {}),
  };
}
