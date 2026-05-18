import {
  evaluateEscalations,
  type EscalationAction,
  type EscalationRequirement,
} from "../escalation/index.js";
import {
  parseClearanceState,
  renderClearanceComment,
  type ClearanceState,
  type ClearanceStateRequirement,
  type StateEvent,
} from "../state/index.js";

export type EscalationWorkflowInput = {
  existingCommentBody?: string;
  now: string;
  requirements: EscalationRequirement[];
};

export type EscalationWorkflowDependencies = {
  postComment(body: string): Promise<void>;
  requestReviewers(reviewers: string[]): Promise<void>;
  upsertComment(body: string): Promise<void>;
};

export type EscalationSideEffectFailure = {
  message: string;
  operation: "post-comment" | "request-reviewers" | "upsert-comment";
};

export type EscalationWorkflowResult = {
  actions: EscalationAction[];
  sideEffectFailures: EscalationSideEffectFailure[];
  state: ClearanceState;
};

export async function processEscalationRun(
  input: EscalationWorkflowInput,
  dependencies: EscalationWorkflowDependencies,
): Promise<EscalationWorkflowResult> {
  const state = parseClearanceState(input.existingCommentBody).state;
  const actions = evaluateEscalations({
    existingEvents: [...state.escalations, ...state.fallbackNotifications],
    now: input.now,
    requirements: input.requirements,
  });
  const nextState = applyEscalationActions(state, actions, input.now);

  const sideEffectFailures = await runEscalationSideEffects([
    {
      execute: () => dependencies.upsertComment(renderClearanceComment(nextState)),
      operation: "upsert-comment",
    },
    ...actions.map((action) => ({
      execute: () => applyEscalationSideEffect(action, dependencies),
      operation:
        action.type === "request_reviewer"
          ? ("request-reviewers" as const)
          : ("post-comment" as const),
    })),
  ]);

  return {
    actions,
    sideEffectFailures,
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

async function applyEscalationSideEffect(
  action: EscalationAction,
  dependencies: EscalationWorkflowDependencies,
): Promise<void> {
  if (action.type === "request_reviewer") {
    await dependencies.requestReviewers([action.reviewer]);
    return;
  }

  await dependencies.postComment(renderActionComment(action));
}

async function runEscalationSideEffects(
  effects: Array<{
    execute(): Promise<void>;
    operation: EscalationSideEffectFailure["operation"];
  }>,
): Promise<EscalationSideEffectFailure[]> {
  const results = await Promise.all(
    effects.map(async (effect): Promise<EscalationSideEffectFailure | undefined> => {
      try {
        await effect.execute();
        return undefined;
      } catch (error) {
        return {
          message: getErrorMessage(error, "unknown error"),
          operation: effect.operation,
        };
      }
    }),
  );

  return results.filter((failure): failure is EscalationSideEffectFailure => failure !== undefined);
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

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
