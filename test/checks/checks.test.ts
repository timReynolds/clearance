import { describe, expect, it } from "vitest";

import { createConfigCheckDecision, createReviewCheckDecision } from "../../src/checks/index.js";
import type { ClearanceStateRequirement } from "../../src/state/index.js";

describe("check decisions", () => {
  it("sets clearance/config success when config has no validation errors", () => {
    expect(
      createConfigCheckDecision({
        diagnostics: [],
      }),
    ).toEqual({
      context: "clearance/config",
      description: "OWNERS.toml configuration is valid",
      state: "success",
    });

    expect(
      createConfigCheckDecision({
        diagnostics: [
          {
            filePath: "OWNERS.toml",
            message: "large quorum",
            schemaPath: "$.rule[0].require[0].count",
            severity: "warning",
          },
        ],
      }),
    ).toEqual({
      context: "clearance/config",
      description: "OWNERS.toml configuration is valid with 1 warning",
      state: "success",
    });
  });

  it("sets clearance/config failure when config has validation errors", () => {
    expect(
      createConfigCheckDecision({
        diagnostics: [
          {
            filePath: "OWNERS.toml",
            message: "bad actor",
            schemaPath: "$.rule[0].require[0].from",
            severity: "error",
          },
        ],
      }),
    ).toEqual({
      context: "clearance/config",
      description: "1 OWNERS.toml validation error",
      state: "failure",
    });
  });

  it("sets clearance/review pending until all requirements are approved", () => {
    expect(
      createReviewCheckDecision({
        requirements: [
          requirement("and:platform", "approved"),
          requirement("and:security", "pending"),
        ],
      }),
    ).toEqual({
      context: "clearance/review",
      description: "1 review requirement pending",
      state: "pending",
    });
  });

  it("sets clearance/review success for satisfied requirements, no requirements, or override", () => {
    expect(
      createReviewCheckDecision({
        requirements: [requirement("and:platform", "approved")],
      }),
    ).toEqual({
      context: "clearance/review",
      description: "All review requirements are satisfied",
      state: "success",
    });

    expect(
      createReviewCheckDecision({
        requirements: [],
      }),
    ).toEqual({
      context: "clearance/review",
      description: "No review requirements were triggered",
      state: "success",
    });

    expect(
      createReviewCheckDecision({
        overrideActive: true,
        requirements: [requirement("and:platform", "pending")],
      }),
    ).toEqual({
      context: "clearance/review",
      description: "Review clearance granted by authorized override",
      state: "success",
    });
  });

  it("sets clearance/review failure for hard runtime errors", () => {
    expect(
      createReviewCheckDecision({
        hardErrors: ["Required team @org/empty has no eligible members"],
        requirements: [requirement("and:platform", "pending")],
      }),
    ).toEqual({
      context: "clearance/review",
      description: "Required team @org/empty has no eligible members",
      state: "failure",
    });
  });
});

function requirement(
  identity: string,
  status: ClearanceStateRequirement["status"],
): ClearanceStateRequirement {
  return {
    approvedBy: status === "approved" ? ["alice"] : [],
    identity,
    label: identity,
    requiredCount: 1,
    status,
    type: "and",
  };
}
