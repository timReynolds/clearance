import {
  evaluateEscalations,
  type EscalationAction,
  type EscalationRequirement,
} from "../escalation/index.js";
import {
  parseClearanceState,
  renderClearanceComment,
  type ClearanceState,
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

export type EscalationWorkflowResult = {
  actions: EscalationAction[];
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

  await Promise.all([
    dependencies.upsertComment(renderClearanceComment(nextState)),
    ...actions.map((action) => applyEscalationSideEffect(action, dependencies)),
  ]);

  return {
    actions,
    state: nextState,
  };
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
