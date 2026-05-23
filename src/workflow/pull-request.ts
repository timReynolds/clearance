import {
  assignReviewers,
  type AssignmentRequirement,
  type AssignmentResult,
  type ReviewerCandidate,
  type ReviewerAssignment,
} from "../assignment/index.js";
import {
  createConfigCheckDecision,
  createReviewCheckDecision,
  type CheckDecision,
} from "../checks/index.js";
import { evaluateOverride, type OverrideCommand } from "../override/index.js";
import type { OwnersDiagnostic, OwnershipTree } from "../owners/index.js";
import {
  resolveOwnership,
  type NotificationRecord,
  type OwnershipResolution,
  type RequirementTrigger,
} from "../resolution/index.js";
import {
  createEmptyClearanceState,
  invalidateStaleApprovals,
  rebuildReviewState,
  recordSubmittedReview,
  renderClearanceComment,
  type AssignmentRecord,
  type ClearanceState,
  type ReviewRequirementDefinition,
} from "../state/index.js";
import type { GithubIdentityResolution } from "../github/index.js";

export type PullRequestWorkflowInput = {
  author: string;
  changedFilesSinceLastApproval?: string[];
  headSha: string;
  labels: string[];
  now: string;
  overrideCommand?: OverrideCommand;
  owner: string;
  pullNumber: number;
  repo: string;
  sender: string;
};

export type SubmittedReviewWorkflowInput = PullRequestWorkflowInput & {
  reviewState: string;
  reviewer: string;
};

export type PullRequestWorkflowDependencies = {
  listChangedFiles(input: PullRequestWorkflowInput): Promise<string[]>;
  listReviewerSignals(
    input: PullRequestWorkflowInput,
    reviewers: string[],
    changedFiles: string[],
  ): Promise<ReviewerSignal[]>;
  loadState(input: PullRequestWorkflowInput): Promise<ClearanceState | undefined>;
  loadOwnershipTree(input: PullRequestWorkflowInput): Promise<OwnershipTree>;
  requestReviewers(input: PullRequestWorkflowInput, reviewers: string[]): Promise<void>;
  resolveIdentities(tree: OwnershipTree): Promise<GithubIdentityResolution>;
  saveState(input: PullRequestWorkflowInput, state: ClearanceState): Promise<void>;
  sendNotifications(
    input: PullRequestWorkflowInput,
    notifications: NotificationRecord[],
  ): Promise<void>;
  setStatuses(input: PullRequestWorkflowInput, decisions: CheckDecision[]): Promise<void>;
  upsertComment(input: PullRequestWorkflowInput, body: string): Promise<void>;
};

export type ReviewerSignal = Pick<ReviewerCandidate, "login"> &
  Partial<Omit<ReviewerCandidate, "id" | "login" | "unavailable">>;

export type WorkflowSideEffectFailure = {
  message: string;
  operation: "request-reviewers" | "send-notifications" | "set-statuses" | "upsert-comment";
};

type WorkflowSideEffect = {
  execute(): Promise<void>;
  operation: WorkflowSideEffectFailure["operation"];
};

export type PullRequestWorkflowResult = {
  changedFiles: string[];
  checks: CheckDecision[];
  sideEffectFailures: WorkflowSideEffectFailure[];
  requestedReviewers: string[];
  state: ClearanceState;
};

type WorkflowContext = {
  assignmentRequirements: AssignmentRequirement[];
  candidatesByActor: Map<string, ReviewerCandidate[]>;
  changedFiles: string[];
  configDiagnostics: OwnersDiagnostic[];
  configValid: boolean;
  definitions: ReviewRequirementDefinition[];
  hardErrors: string[];
  identityResolution: GithubIdentityResolution;
  reviewerAssignments: AssignmentResult;
  dryRun: boolean;
  ownershipResolution: OwnershipResolution;
  ownershipTree: OwnershipTree;
};

export async function processPullRequestChange(
  input: PullRequestWorkflowInput,
  dependencies: PullRequestWorkflowDependencies,
): Promise<PullRequestWorkflowResult> {
  const context = await buildWorkflowContext(input, dependencies);
  const dryRun = context.dryRun;
  const previousState = await loadPreviousState(input, dependencies);
  const baseState =
    input.changedFilesSinceLastApproval === undefined
      ? rebuildReviewState({
          definitions: context.definitions,
          headSha: input.headSha,
          now: input.now,
          previousState,
        })
      : invalidateStaleApprovals(previousState, {
          changedFiles: input.changedFilesSinceLastApproval,
          definitions: context.definitions,
          headSha: input.headSha,
          now: input.now,
        });
  const assignmentRecords = dryRun
    ? baseState.assignments
    : buildAssignmentRecords(
        baseState.assignments,
        context.reviewerAssignments.assignments,
        input.now,
      );
  const state = {
    ...baseState,
    assignments: assignmentRecords,
    warnings: [
      ...context.configDiagnostics.map((diagnostic) => ({
        message: `${diagnostic.filePath} ${diagnostic.schemaPath}: ${diagnostic.message}`,
      })),
      ...context.reviewerAssignments.warnings.map((message) => ({ message })),
    ],
  };
  const overrideResult = applyWorkflowOverride(input, context, state);
  const finalState = applyDryRunState(overrideResult.state, dryRun);
  const checks = createWorkflowChecks(context, finalState, overrideResult.active);
  const pendingNotifications =
    context.configValid && overrideResult.active !== true && !dryRun
      ? getPendingNotifications(baseState, context.ownershipResolution.notifications)
      : [];
  const requestedReviewers =
    context.configValid && overrideResult.active !== true && !dryRun
      ? getNewAssignmentReviewers(baseState.assignments, assignmentRecords, finalState.requirements)
      : [];
  const finalStateWithNotifications = {
    ...finalState,
    notificationsSent: [
      ...new Set([
        ...finalState.notificationsSent,
        ...pendingNotifications.map((notification) => notification.identity),
      ]),
    ].toSorted(compareStrings),
  };

  await dependencies.saveState(input, finalStateWithNotifications);

  const sideEffectFailures = await runWorkflowSideEffects([
    {
      execute: () =>
        dependencies.upsertComment(input, renderClearanceComment(finalStateWithNotifications)),
      operation: "upsert-comment",
    },
    ...getEnforcementSideEffects(
      input,
      dependencies,
      checks,
      requestedReviewers,
      pendingNotifications,
      dryRun,
    ),
  ]);

  return {
    changedFiles: context.changedFiles,
    checks,
    sideEffectFailures,
    requestedReviewers,
    state: finalStateWithNotifications,
  };
}

export async function processSubmittedReview(
  input: SubmittedReviewWorkflowInput,
  dependencies: PullRequestWorkflowDependencies,
): Promise<PullRequestWorkflowResult> {
  const context = await buildWorkflowContext(input, dependencies);
  const dryRun = context.dryRun;
  const previousState = await loadPreviousState(input, dependencies);
  const state = recordSubmittedReview(previousState, {
    approvedAt: input.now,
    definitions: context.definitions,
    headSha: input.headSha,
    reviewer: input.reviewer,
    state: input.reviewState,
  });
  const reconciledState = applyDryRunState(reconcileStoredOverride(context, state), dryRun);
  const checks = createWorkflowChecks(
    context,
    reconciledState,
    reconciledState.override !== undefined,
  );

  await dependencies.saveState(input, reconciledState);

  const sideEffectFailures = await runWorkflowSideEffects([
    {
      execute: () => dependencies.upsertComment(input, renderClearanceComment(reconciledState)),
      operation: "upsert-comment",
    },
    ...getSubmittedReviewEnforcementSideEffects(input, dependencies, checks, dryRun),
  ]);

  return {
    changedFiles: context.changedFiles,
    checks,
    sideEffectFailures,
    requestedReviewers: [],
    state: reconciledState,
  };
}

function applyDryRunState(state: ClearanceState, dryRun: boolean): ClearanceState {
  if (dryRun) {
    return {
      ...state,
      dryRun: true,
    };
  }

  const nextState = { ...state };
  delete nextState.dryRun;
  return nextState;
}

function getEnforcementSideEffects(
  input: PullRequestWorkflowInput,
  dependencies: PullRequestWorkflowDependencies,
  checks: CheckDecision[],
  requestedReviewers: string[],
  pendingNotifications: NotificationRecord[],
  dryRun: boolean,
): WorkflowSideEffect[] {
  if (dryRun) {
    return [];
  }

  return [
    {
      execute: () => dependencies.setStatuses(input, checks),
      operation: "set-statuses",
    },
    {
      execute: () => dependencies.requestReviewers(input, requestedReviewers),
      operation: "request-reviewers",
    },
    {
      execute: () => dependencies.sendNotifications(input, pendingNotifications),
      operation: "send-notifications",
    },
  ];
}

function getSubmittedReviewEnforcementSideEffects(
  input: PullRequestWorkflowInput,
  dependencies: PullRequestWorkflowDependencies,
  checks: CheckDecision[],
  dryRun: boolean,
): WorkflowSideEffect[] {
  if (dryRun) {
    return [];
  }

  return [
    {
      execute: () => dependencies.setStatuses(input, checks),
      operation: "set-statuses",
    },
  ];
}

async function loadPreviousState(
  input: PullRequestWorkflowInput,
  dependencies: PullRequestWorkflowDependencies,
): Promise<ClearanceState> {
  return (await dependencies.loadState(input)) ?? createEmptyClearanceState();
}

async function buildWorkflowContext(
  input: PullRequestWorkflowInput,
  dependencies: PullRequestWorkflowDependencies,
): Promise<WorkflowContext> {
  const [ownershipTree, changedFiles] = await Promise.all([
    dependencies.loadOwnershipTree(input),
    dependencies.listChangedFiles(input),
  ]);
  const ownershipResolution = resolveOwnership({
    changedFiles,
    ownershipFiles: ownershipTree.files,
  });
  const identityResolution = await dependencies.resolveIdentities(ownershipTree);
  const configDiagnostics = [...ownershipTree.diagnostics, ...identityResolution.diagnostics];
  const configValid = configDiagnostics.every((diagnostic) => diagnostic.severity !== "error");
  const reviewerSignals = await dependencies.listReviewerSignals(
    input,
    getCandidateLoginsFromIdentityResolution(identityResolution),
    changedFiles,
  );
  const candidatesByActor = buildCandidatesByActor(identityResolution, reviewerSignals);
  const assignmentRequirements = buildAssignmentRequirements(ownershipResolution);
  const reviewerAssignments = assignReviewers({
    author: input.author,
    candidatesByActor,
    requirements: assignmentRequirements,
  });
  const definitions = buildReviewDefinitions(
    ownershipResolution,
    assignmentRequirements,
    candidatesByActor,
    reviewerAssignments.assignments,
    ownershipTree,
  );
  const hardErrors = buildHardErrors(configDiagnostics, assignmentRequirements, candidatesByActor);

  return {
    assignmentRequirements,
    candidatesByActor,
    changedFiles,
    configDiagnostics,
    configValid,
    definitions,
    dryRun: ownershipResolution.dryRun,
    hardErrors,
    identityResolution,
    reviewerAssignments,
    ownershipResolution,
    ownershipTree,
  };
}

function buildCandidatesByActor(
  identityResolution: GithubIdentityResolution,
  reviewerSignals: ReviewerSignal[],
): Map<string, ReviewerCandidate[]> {
  const candidatesByActor = new Map<string, ReviewerCandidate[]>();
  const signalsByLogin = new Map(reviewerSignals.map((signal) => [signal.login, signal]));

  for (const [actor, user] of identityResolution.users) {
    candidatesByActor.set(actor, [buildReviewerCandidate(user.login, user.id, signalsByLogin)]);
  }

  for (const [actor, team] of identityResolution.teams) {
    candidatesByActor.set(
      actor,
      team.members.map((member) => buildReviewerCandidate(member.login, member.id, signalsByLogin)),
    );
  }

  return candidatesByActor;
}

function buildReviewerCandidate(
  login: string,
  id: number | undefined,
  signalsByLogin: Map<string, ReviewerSignal>,
): ReviewerCandidate {
  const signal = signalsByLogin.get(login);

  return {
    blameCoverage: signal?.blameCoverage,
    currentLoad: signal?.currentLoad,
    id,
    login,
    reviewHistory: signal?.reviewHistory,
    roundRobinRank: signal?.roundRobinRank,
  };
}

function getCandidateLoginsFromIdentityResolution(
  identityResolution: GithubIdentityResolution,
): string[] {
  return [
    ...new Set([
      ...[...identityResolution.users.values()].map((user) => user.login),
      ...[...identityResolution.teams.values()].flatMap((team) =>
        team.members.map((member) => member.login),
      ),
    ]),
  ].toSorted(compareStrings);
}

function buildAssignmentRequirements(resolution: OwnershipResolution): AssignmentRequirement[] {
  return [
    ...resolution.andRequirements.map((requirement): AssignmentRequirement => {
      return {
        count: requirement.count,
        from: requirement.from,
        identity: requirement.identity,
        type: "and",
      };
    }),
    ...resolution.orRequirements.map((requirement): AssignmentRequirement => {
      return {
        identity: requirement.identity,
        options: requirement.options,
        type: "or",
      };
    }),
  ];
}

function buildReviewDefinitions(
  resolution: OwnershipResolution,
  assignmentRequirements: AssignmentRequirement[],
  candidatesByActor: Map<string, ReviewerCandidate[]>,
  reviewerAssignments: ReviewerAssignment[],
  ownershipTree: OwnershipTree,
): ReviewRequirementDefinition[] {
  return assignmentRequirements.map((requirement) => {
    const selectedAssignment = reviewerAssignments.find(
      (assignment) => assignment.requirementIdentity === requirement.identity,
    );

    if (requirement.type === "and") {
      const resolvedRequirement = resolution.andRequirements.find(
        (andRequirement) => andRequirement.identity === requirement.identity,
      );
      const policy = getEscalationPolicy(resolvedRequirement?.triggers ?? [], ownershipTree);

      return {
        ...policy,
        assignedReviewers: selectedAssignment?.reviewers ?? [],
        eligibleReviewers: getCandidateLogins(candidatesByActor, requirement.from),
        identity: requirement.identity,
        label: `${requirement.from} approval`,
        relevantFiles: getRelevantFiles(resolvedRequirement?.triggers ?? []),
        requiredCount: requirement.count,
        type: requirement.type,
      };
    }

    const selectedOption = requirement.options.find(
      (option) => option.from === selectedAssignment?.actor,
    );
    const resolvedRequirement = resolution.orRequirements.find(
      (orRequirement) => orRequirement.identity === requirement.identity,
    );
    const policy = getEscalationPolicy(resolvedRequirement?.triggers ?? [], ownershipTree);
    const approvalOptions = requirement.options.map((option) => ({
      eligibleReviewers: getCandidateLogins(candidatesByActor, option.from),
      from: option.from,
      requiredCount: option.count,
    }));

    return {
      ...policy,
      approvalOptions,
      assignedReviewers: selectedAssignment?.reviewers ?? [],
      eligibleReviewers: [
        ...new Set(approvalOptions.flatMap((option) => option.eligibleReviewers)),
      ].toSorted(compareStrings),
      identity: requirement.identity,
      label: requirement.options.map((option) => option.from).join(" or "),
      relevantFiles: getRelevantFiles(resolvedRequirement?.triggers ?? []),
      requiredCount: selectedOption?.count ?? 1,
      type: requirement.type,
    };
  });
}

function getEscalationPolicy(
  triggers: RequirementTrigger[],
  ownershipTree: OwnershipTree,
): Pick<
  ReviewRequirementDefinition,
  "escalateAfter" | "fallbackAfter" | "fallbackTeam" | "resetOnPush" | "warnAfter"
> {
  for (const trigger of triggers) {
    const ownershipFile = ownershipTree.files.find((file) => file.path === trigger.ownersPath);
    const config = ownershipFile?.config;
    const policy = config?.rule[trigger.ruleIndex]?.escalation ?? config?.escalation;
    if (policy !== undefined) {
      return {
        escalateAfter: policy.escalate_after,
        fallbackAfter: policy.fallback_after,
        fallbackTeam: policy.fallback_team,
        resetOnPush: policy.reset_on_push,
        warnAfter: policy.warn_after,
      };
    }
  }

  return {};
}

function getCandidateLogins(
  candidatesByActor: Map<string, ReviewerCandidate[]>,
  actor: string,
): string[] {
  return (candidatesByActor.get(actor) ?? [])
    .map((candidate) => candidate.login)
    .toSorted(compareStrings);
}

function getRelevantFiles(triggers: Array<{ changedFile: string }>): string[] {
  return [...new Set(triggers.map((trigger) => trigger.changedFile))].toSorted(compareStrings);
}

function buildHardErrors(
  diagnostics: OwnersDiagnostic[],
  requirements: AssignmentRequirement[],
  candidatesByActor: Map<string, ReviewerCandidate[]>,
): string[] {
  const diagnosticErrors = diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => `${diagnostic.filePath} ${diagnostic.schemaPath}: ${diagnostic.message}`);
  const assignmentErrors = requirements.flatMap((requirement) => {
    if (requirement.type === "and") {
      return (candidatesByActor.get(requirement.from) ?? []).length === 0
        ? [`Required actor ${requirement.from} has no eligible reviewers`]
        : [];
    }

    return requirement.options.every(
      (option) => (candidatesByActor.get(option.from) ?? []).length === 0,
    )
      ? [`Requirement ${requirement.identity} has no eligible reviewers`]
      : [];
  });

  return [...diagnosticErrors, ...assignmentErrors];
}

function buildAssignmentRecords(
  existingAssignments: AssignmentRecord[],
  reviewerAssignments: ReviewerAssignment[],
  now: string,
): AssignmentRecord[] {
  return reviewerAssignments
    .filter((assignment) => assignment.reviewers.length > 0)
    .map((assignment) => {
      const existingAssignment = existingAssignments.find(
        (record) => record.requirementIdentity === assignment.requirementIdentity,
      );

      return {
        assignedAt: existingAssignment?.assignedAt ?? now,
        requirementIdentity: assignment.requirementIdentity,
        reviewers: assignment.reviewers.toSorted(compareStrings),
      };
    })
    .toSorted((left, right) => compareStrings(left.requirementIdentity, right.requirementIdentity));
}

function getNewAssignmentReviewers(
  existingAssignments: AssignmentRecord[],
  assignmentRecords: AssignmentRecord[],
  requirements: ClearanceState["requirements"],
): string[] {
  const existingRequirementIdentities = new Set(
    existingAssignments.map((assignment) => assignment.requirementIdentity),
  );
  const pendingRequirementIdentities = new Set(
    requirements
      .filter((requirement) => requirement.status !== "approved")
      .map((requirement) => requirement.identity),
  );

  return [
    ...new Set(
      assignmentRecords
        .filter(
          (assignment) =>
            pendingRequirementIdentities.has(assignment.requirementIdentity) &&
            !existingRequirementIdentities.has(assignment.requirementIdentity),
        )
        .flatMap((assignment) => assignment.reviewers),
    ),
  ].toSorted(compareStrings);
}

function getPendingNotifications(
  state: ClearanceState,
  notifications: NotificationRecord[],
): NotificationRecord[] {
  const sentNotifications = new Set(state.notificationsSent);
  return notifications.filter((notification) => !sentNotifications.has(notification.identity));
}

function applyWorkflowOverride(
  input: PullRequestWorkflowInput,
  context: WorkflowContext,
  state: ClearanceState,
): { active: boolean; state: ClearanceState } {
  const reconciledState = reconcileStoredOverride(context, state);
  if (input.overrideCommand === undefined) {
    return {
      active: reconciledState.override !== undefined,
      state: reconciledState,
    };
  }

  const evaluation = evaluateWorkflowOverride(input, context, input.overrideCommand);
  if (evaluation.type === "activate") {
    return {
      active: true,
      state: {
        ...reconciledState,
        override: {
          actor: evaluation.actor,
          at: input.now,
          commentId: evaluation.commentId,
        },
      },
    };
  }

  if (evaluation.type === "revoke") {
    return {
      active: false,
      state: {
        ...reconciledState,
        override: undefined,
      },
    };
  }

  return {
    active: reconciledState.override !== undefined,
    state: reconciledState,
  };
}

function reconcileStoredOverride(context: WorkflowContext, state: ClearanceState): ClearanceState {
  if (state.override === undefined) {
    return state;
  }

  const evaluation = evaluateWorkflowOverride(
    {
      now: state.override.at,
      sender: state.override.actor,
    },
    context,
    {
      commentId: state.override.commentId,
      type: "activate",
    },
  );

  return evaluation.type === "activate"
    ? state
    : {
        ...state,
        override: undefined,
      };
}

function evaluateWorkflowOverride(
  input: Pick<PullRequestWorkflowInput, "now" | "sender">,
  context: WorkflowContext,
  command: OverrideCommand,
) {
  return evaluateOverride({
    actor: input.sender,
    at: input.now,
    command,
    configValid: context.configValid,
    ownershipFiles: context.ownershipTree.files,
    teamMembersByActor: getTeamMembersByActor(context),
  });
}

function getTeamMembersByActor(context: WorkflowContext): Map<string, string[]> {
  return new Map(
    [...context.identityResolution.teams.entries()].map(([actor, team]) => [
      actor,
      team.members.map((member) => member.login),
    ]),
  );
}

function createWorkflowChecks(
  context: WorkflowContext,
  state: ClearanceState,
  overrideActive: boolean,
): CheckDecision[] {
  return [
    createConfigCheckDecision({
      diagnostics: context.configDiagnostics,
    }),
    createReviewCheckDecision({
      hardErrors: context.hardErrors,
      overrideActive,
      requirements: state.requirements,
    }),
  ];
}

async function runWorkflowSideEffects(
  effects: WorkflowSideEffect[],
): Promise<WorkflowSideEffectFailure[]> {
  const results = await Promise.all(
    effects.map(async (effect): Promise<WorkflowSideEffectFailure | undefined> => {
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

  return results.filter((failure): failure is WorkflowSideEffectFailure => failure !== undefined);
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
