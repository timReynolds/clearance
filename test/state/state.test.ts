import { describe, expect, it } from "vitest";

import {
  createEmptyClearanceState,
  parseClearanceState,
  renderClearanceComment,
  serializeClearanceState,
  type ClearanceState,
} from "../../src/state/index.js";

describe("Clearance state", () => {
  it("round-trips hidden JSON state from rendered comments", () => {
    const state = exampleState();
    const markdown = renderClearanceComment(state);
    const parsed = parseClearanceState(markdown);

    expect(parsed).toEqual({
      ok: true,
      state,
    });
    expect(markdown).toContain("## Clearance");
    expect(markdown).toContain("| Status | Requirement | Type | Needed | Approved By | Head SHA |");
    expect(markdown).toContain("<!-- clearance-state:v1");
  });

  it("falls back to an empty state when the comment is missing or malformed", () => {
    expect(parseClearanceState(undefined)).toEqual({
      ok: false,
      reason: "missing Clearance comment",
      state: createEmptyClearanceState(),
    });
    expect(parseClearanceState("## Clearance")).toEqual({
      ok: false,
      reason: "missing hidden Clearance state block",
      state: createEmptyClearanceState(),
    });
    expect(parseClearanceState("<!-- clearance-state:v1\nnot json\n-->")).toEqual({
      ok: false,
      reason: "hidden Clearance state block contains malformed JSON",
      state: createEmptyClearanceState(),
    });
  });

  it("rejects unsupported hidden state shapes", () => {
    const parsed = parseClearanceState(
      `Visible text\n\n${serializeClearanceState({
        ...createEmptyClearanceState(),
        version: 1,
      }).replace('"version": 1', '"version": 2')}`,
    );

    expect(parsed).toEqual({
      ok: false,
      reason: "hidden Clearance state block has an unsupported shape",
      state: createEmptyClearanceState(),
    });
  });

  it("renders pending and granted requirements with warnings and audit events", () => {
    const markdown = renderClearanceComment(exampleState());

    expect(markdown).toContain("1 review requirement pending.");
    expect(markdown).toContain("| Granted | Platform approval | AND | 1 | `alice` | `abc123` |");
    expect(markdown).toContain("| Pending | Security or compliance | OR | 1 | - | - |");
    expect(markdown).toContain("### Warnings");
    expect(markdown).toContain("- `or:security`: too few eligible reviewers");
    expect(markdown).toContain("### Audit Log");
    expect(markdown).toContain("2026-05-17T10:30:00.000Z: Warned assigned reviewers");
  });

  it("renders an override-granted summary", () => {
    const state: ClearanceState = {
      ...createEmptyClearanceState(),
      override: {
        actor: "repo-admin",
        at: "2026-05-17T11:00:00.000Z",
        commentId: 123,
      },
    };

    const markdown = renderClearanceComment(state);

    expect(markdown).toContain("Review clearance is granted by @clearance override.");
    expect(markdown).toContain("Override activated by @clearance override command by `repo-admin`");
  });

  it("renders a dry-run notice from persisted state", () => {
    const state: ClearanceState = {
      ...exampleState(),
      dryRun: true,
    };
    const markdown = renderClearanceComment(state);

    expect(markdown).toContain("Dry run mode is active.");
    expect(parseClearanceState(markdown).state).toEqual(state);
  });
});

function exampleState(): ClearanceState {
  return {
    approvals: [
      {
        approvedAt: "2026-05-17T10:00:00.000Z",
        headSha: "abc123",
        requirementIdentity: "and:platform",
        reviewer: "alice",
      },
    ],
    assignments: [
      {
        assignedAt: "2026-05-17T09:00:00.000Z",
        requirementIdentity: "and:platform",
        reviewers: ["alice"],
      },
    ],
    escalations: [
      {
        at: "2026-05-17T10:30:00.000Z",
        message: "Warned assigned reviewers",
        requirementIdentity: "or:security",
        type: "warning",
      },
    ],
    fallbackNotifications: [],
    notificationsSent: ["notify:docs"],
    requirements: [
      {
        approvedBy: ["alice"],
        approvedHeadSha: "abc123",
        identity: "and:platform",
        label: "Platform approval",
        requiredCount: 1,
        status: "approved",
        type: "and",
      },
      {
        approvedBy: [],
        identity: "or:security",
        label: "Security or compliance",
        requiredCount: 1,
        status: "pending",
        type: "or",
      },
    ],
    version: 1,
    warnings: [
      {
        message: "too few eligible reviewers",
        requirementIdentity: "or:security",
      },
    ],
  };
}
