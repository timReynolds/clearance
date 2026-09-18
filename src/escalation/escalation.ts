import type { StateEvent } from "../state/index.js";

export type EscalationRequirement = {
  assignedReviewers: string[];
  eligibleReviewers: string[];
  escalateAfter?: string;
  fallbackAfter?: string;
  fallbackTeam?: string;
  identity: string;
  pendingSince: string;
  resetOnPush?: boolean;
  status: "approved" | "pending";
  updatedAt?: string;
  warnAfter?: string;
};

export type EscalationAction =
  | {
      message: string;
      requirementIdentity: string;
      reviewers: string[];
      type: "warn";
    }
  | {
      message: string;
      requirementIdentity: string;
      reviewer: string;
      type: "request_reviewer";
    }
  | {
      message: string;
      requirementIdentity: string;
      team: string;
      type: "fallback";
    };

export type EscalationInput = {
  existingEvents?: StateEvent[];
  now: string;
  requirements: EscalationRequirement[];
};

export function evaluateEscalations(input: EscalationInput): EscalationAction[] {
  const existingEvents = input.existingEvents ?? [];
  const now = Date.parse(input.now);

  return input.requirements.flatMap((requirement) => {
    if (requirement.status !== "pending") {
      return [];
    }

    const baseTime = Date.parse(
      requirement.resetOnPush === true && requirement.updatedAt !== undefined
        ? requirement.updatedAt
        : requirement.pendingSince,
    );
    const elapsedMs = now - baseTime;
    const actions: EscalationAction[] = [];

    if (
      requirement.warnAfter !== undefined &&
      elapsedMs >= parseDurationMs(requirement.warnAfter) &&
      !hasEvent(existingEvents, requirement.identity, "warning")
    ) {
      actions.push({
        message: `Warn assigned reviewers for ${requirement.identity}`,
        requirementIdentity: requirement.identity,
        reviewers: requirement.assignedReviewers,
        type: "warn",
      });
    }

    if (
      requirement.escalateAfter !== undefined &&
      elapsedMs >= parseDurationMs(requirement.escalateAfter) &&
      !hasEvent(existingEvents, requirement.identity, "escalation")
    ) {
      const reviewer = requirement.eligibleReviewers.find(
        (candidate) => !requirement.assignedReviewers.includes(candidate),
      );
      if (reviewer !== undefined) {
        actions.push({
          message: `Request another reviewer for ${requirement.identity}`,
          requirementIdentity: requirement.identity,
          reviewer,
          type: "request_reviewer",
        });
      }
    }

    if (
      requirement.fallbackAfter !== undefined &&
      requirement.fallbackTeam !== undefined &&
      elapsedMs >= parseDurationMs(requirement.fallbackAfter) &&
      !hasEvent(existingEvents, requirement.identity, "fallback")
    ) {
      actions.push({
        message: `Notify fallback team ${requirement.fallbackTeam} for ${requirement.identity}`,
        requirementIdentity: requirement.identity,
        team: requirement.fallbackTeam,
        type: "fallback",
      });
    }

    return actions;
  });
}

function hasEvent(events: StateEvent[], requirementIdentity: string, type: string): boolean {
  return events.some(
    (event) => event.requirementIdentity === requirementIdentity && event.type === type,
  );
}

function parseDurationMs(duration: string): number {
  const match = /^(?<amount>[1-9]\d*)(?<unit>[smhdw])$/.exec(duration);
  if (match?.groups === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  const amount = Number.parseInt(match.groups.amount ?? "0", 10);
  switch (match.groups.unit) {
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    case "d":
      return amount * 24 * 60 * 60 * 1000;
    case "w":
      return amount * 7 * 24 * 60 * 60 * 1000;
    default:
      return Number.POSITIVE_INFINITY;
  }
}
