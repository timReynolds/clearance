import { describe, expect, it } from "vitest";

import { evaluateEscalations, type EscalationRequirement } from "../../src/escalation/index.js";

describe("evaluateEscalations", () => {
  it("emits warning, escalation, and fallback actions when thresholds are due", () => {
    const actions = evaluateEscalations({
      now: "2026-05-17T12:00:00.000Z",
      requirements: [
        requirement({
          assignedReviewers: ["alice"],
          eligibleReviewers: ["alice", "bob"],
          escalateAfter: "2h",
          fallbackAfter: "4h",
          fallbackTeam: "@org/leads",
          pendingSince: "2026-05-17T07:00:00.000Z",
          warnAfter: "1h",
        }),
      ],
    });

    expect(actions).toEqual([
      {
        message: "Warn assigned reviewers for and:platform",
        requirementIdentity: "and:platform",
        reviewers: ["alice"],
        type: "warn",
      },
      {
        message: "Request another reviewer for and:platform",
        requirementIdentity: "and:platform",
        reviewer: "bob",
        type: "request_reviewer",
      },
      {
        message: "Notify fallback team @org/leads for and:platform",
        requirementIdentity: "and:platform",
        team: "@org/leads",
        type: "fallback",
      },
    ]);
  });

  it("does not duplicate events that already exist", () => {
    const actions = evaluateEscalations({
      existingEvents: [
        {
          at: "2026-05-17T08:00:00.000Z",
          message: "warned",
          requirementIdentity: "and:platform",
          type: "warning",
        },
        {
          at: "2026-05-17T09:00:00.000Z",
          message: "escalated",
          requirementIdentity: "and:platform",
          type: "escalation",
        },
      ],
      now: "2026-05-17T12:00:00.000Z",
      requirements: [
        requirement({
          assignedReviewers: ["alice"],
          eligibleReviewers: ["alice", "bob"],
          escalateAfter: "2h",
          fallbackAfter: "4h",
          fallbackTeam: "@org/leads",
          pendingSince: "2026-05-17T07:00:00.000Z",
          warnAfter: "1h",
        }),
      ],
    });

    expect(actions).toEqual([
      {
        message: "Notify fallback team @org/leads for and:platform",
        requirementIdentity: "and:platform",
        team: "@org/leads",
        type: "fallback",
      },
    ]);
  });

  it("uses updatedAt as the timing base when resetOnPush is enabled", () => {
    const actions = evaluateEscalations({
      now: "2026-05-17T12:00:00.000Z",
      requirements: [
        requirement({
          pendingSince: "2026-05-17T07:00:00.000Z",
          resetOnPush: true,
          updatedAt: "2026-05-17T11:30:00.000Z",
          warnAfter: "1h",
        }),
      ],
    });

    expect(actions).toEqual([]);
  });

  it("supports every duration unit and ignores malformed durations", () => {
    const actions = evaluateEscalations({
      now: "2026-05-17T12:00:00.000Z",
      requirements: [
        requirement({
          identity: "seconds",
          pendingSince: "2026-05-17T11:59:29.000Z",
          warnAfter: "30s",
        }),
        requirement({
          identity: "minutes",
          pendingSince: "2026-05-17T11:57:00.000Z",
          warnAfter: "2m",
        }),
        requirement({
          identity: "days",
          pendingSince: "2026-05-16T11:59:59.000Z",
          warnAfter: "1d",
        }),
        requirement({
          identity: "weeks",
          pendingSince: "2026-05-10T12:00:00.000Z",
          warnAfter: "1w",
        }),
        requirement({
          identity: "bad-duration",
          pendingSince: "2026-05-10T12:00:00.000Z",
          warnAfter: "soon",
        }),
      ],
    });

    expect(actions.map((action) => action.requirementIdentity)).toEqual([
      "seconds",
      "minutes",
      "days",
      "weeks",
    ]);
  });

  it("ignores approved requirements and skips add-reviewer when no extra reviewer exists", () => {
    const actions = evaluateEscalations({
      now: "2026-05-17T12:00:00.000Z",
      requirements: [
        requirement({
          pendingSince: "2026-05-17T07:00:00.000Z",
          status: "approved",
          warnAfter: "1h",
        }),
        requirement({
          assignedReviewers: ["alice"],
          eligibleReviewers: ["alice"],
          escalateAfter: "1h",
          identity: "and:security",
          pendingSince: "2026-05-17T07:00:00.000Z",
        }),
      ],
    });

    expect(actions).toEqual([]);
  });
});

function requirement(overrides: Partial<EscalationRequirement> = {}): EscalationRequirement {
  return {
    assignedReviewers: [],
    eligibleReviewers: [],
    identity: "and:platform",
    pendingSince: "2026-05-17T10:00:00.000Z",
    status: "pending",
    ...overrides,
  };
}
