import type { OwnersDiagnostic } from "../owners/index.js";
import type { ClearanceStateRequirement } from "../state/index.js";

export const clearanceConfigContext = "clearance/config";
export const clearanceReviewContext = "clearance/review";

export type CheckState = "error" | "failure" | "pending" | "success";

export type CheckDecision = {
  context: typeof clearanceConfigContext | typeof clearanceReviewContext;
  description: string;
  state: CheckState;
};

export type ConfigCheckInput = {
  diagnostics: OwnersDiagnostic[];
};

export type ReviewCheckInput = {
  hardErrors?: string[];
  overrideActive?: boolean;
  requirements: ClearanceStateRequirement[];
};

export function createConfigCheckDecision(input: ConfigCheckInput): CheckDecision {
  const errorCount = input.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
  if (errorCount > 0) {
    return {
      context: clearanceConfigContext,
      description: `${errorCount} OWNERS.toml validation error${errorCount === 1 ? "" : "s"}`,
      state: "failure",
    };
  }

  const warningCount = input.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  ).length;

  return {
    context: clearanceConfigContext,
    description:
      warningCount === 0
        ? "OWNERS.toml configuration is valid"
        : `OWNERS.toml configuration is valid with ${warningCount} warning${warningCount === 1 ? "" : "s"}`,
    state: "success",
  };
}

export function createReviewCheckDecision(input: ReviewCheckInput): CheckDecision {
  const hardErrors = input.hardErrors ?? [];
  if (hardErrors.length > 0) {
    return {
      context: clearanceReviewContext,
      description: hardErrors[0] ?? "Clearance cannot reliably enforce review requirements",
      state: "failure",
    };
  }

  if (input.overrideActive === true) {
    return {
      context: clearanceReviewContext,
      description: "Review clearance granted by authorized override",
      state: "success",
    };
  }

  const pendingCount = input.requirements.filter(
    (requirement) => requirement.status !== "approved",
  ).length;

  if (pendingCount > 0) {
    return {
      context: clearanceReviewContext,
      description: `${pendingCount} review requirement${pendingCount === 1 ? "" : "s"} pending`,
      state: "pending",
    };
  }

  return {
    context: clearanceReviewContext,
    description:
      input.requirements.length === 0
        ? "No review requirements were triggered"
        : "All review requirements are satisfied",
    state: "success",
  };
}
