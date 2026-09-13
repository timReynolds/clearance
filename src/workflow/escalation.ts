import {
  evaluateEscalations,
  type EscalationAction,
  type EscalationRequirement,
} from "../escalation/index.js";
import {
  renderClearanceComment,
  type ClearanceState,
  type ClearanceStateRequirement,
  type StateEvent,
} from "../state/index.js";
import type { ReviewTransition, ReviewTransitionEffect } from "./transition.js";

export type EscalationWorkflowInput = {
  now: string;
  requirements: EscalationRequirement[];
  state: ClearanceState;
};

export type EscalationWorkflowDependencies = {
  commitTransition(transition: ReviewTransition): Promise<void>;
};

export type EscalationWorkflowResult = {
  actions: EscalationAction[];
  state: ClearanceState;
};

export async function processEscalationRun(
  input: EscalationWorkflowInput,
  dependencies: EscalationWorkflowDependencies,
): Promise<EscalationWorkflowResult> {
  const state = input.state;
  const dryRun = state.dryRun === true;
  const actions = dryRun
    ? []
    : evaluateEscalations({
        existingEvents: [...state.escalations, ...state.fallbackNotifications],
        now: input.now,
        requirements: input.requirements,
      });
  const nextState = applyEscalationActions(state, actions, input.now);

  const effects: ReviewTransitionEffect[] = [
    { type: "upsert-comment", body: renderClearanceComment(nextState) },
    ...actions.map(
      (action): ReviewTransitionEffect =>
        action.type === "request_reviewer"
          ? { type: "request-reviewers", reviewers: [action.reviewer] }
          : { type: "post-comment", body: renderActionComment(action) },
    ),
  ];
  await dependencies.commitTransition({ state: nextState, effects });

  return {
    actions,
    state: nextState,
  };
}

export function buildEscalationRequirementsFromState(
  state: ClearanceState,
  now: string,
): EscalationRequirement[] {
  return state.requirements.flatMap((requirement) => {
    if (requirement.status !== "pending") {
      return [];
    }

    return [
      {
        assignedReviewers: getAssignedReviewers(state, requirement),
        eligibleReviewers: requirement.eligibleReviewers ?? [],
        escalateAfter: requirement.escalateAfter,
        fallbackAfter: requirement.fallbackAfter,
        fallbackTeam: requirement.fallbackTeam,
        identity: requirement.identity,
        pendingSince: requirement.pendingSince ?? getAssignmentTime(state, requirement) ?? now,
        resetOnPush: requirement.resetOnPush,
        status: requirement.status,
        updatedAt: requirement.updatedAt,
        warnAfter: requirement.warnAfter,
      },
    ];
  });
}

function applyEscalationActions(
  state: ClearanceState,
  actions: EscalationAction[],
  now: string,
): ClearanceState {
  const escalations = [...state.escalations];
  const fallbackNotifications = [...state.fallbackNotifications];

  for (const action of actions) {
    const event = createStateEvent(action, now);

    if (action.type === "fallback") {
      fallbackNotifications.push(event);
      continue;
    }

    escalations.push(event);
  }

  return {
    ...state,
    escalations,
    fallbackNotifications,
  };
}

function getAssignedReviewers(
  state: ClearanceState,
  requirement: ClearanceStateRequirement,
): string[] {
  return (
    requirement.assignedReviewers ??
    state.assignments.find((assignment) => assignment.requirementIdentity === requirement.identity)
      ?.reviewers ??
    []
  );
}

function getAssignmentTime(
  state: ClearanceState,
  requirement: ClearanceStateRequirement,
): string | undefined {
  return state.assignments.find(
    (assignment) => assignment.requirementIdentity === requirement.identity,
  )?.assignedAt;
}

function createStateEvent(action: EscalationAction, now: string): StateEvent {
  if (action.type === "warn") {
    return {
      at: now,
      message: action.message,
      requirementIdentity: action.requirementIdentity,
      type: "warning",
    };
  }

  if (action.type === "request_reviewer") {
    return {
      actor: action.reviewer,
      at: now,
      message: action.message,
      requirementIdentity: action.requirementIdentity,
      type: "escalation",
    };
  }

  return {
    actor: action.team,
    at: now,
    message: action.message,
    requirementIdentity: action.requirementIdentity,
    type: "fallback",
  };
}

function renderActionComment(action: EscalationAction): string {
  if (action.type === "warn") {
    return `${action.message}: ${action.reviewers.map((reviewer) => `@${reviewer}`).join(" ")}`;
  }

  if (action.type === "fallback") {
    return `${action.message}: ${action.team}`;
  }

  return action.message;
}
