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
import { evaluateOverride } from "../override/index.js";
import type { OwnersDiagnostic, OwnershipTree } from "../owners/index.js";
import {
  resolveOwnership,
  type NotificationRecord,
  type OwnershipResolution,
  type RequirementTrigger,
} from "../resolution/index.js";
import {
  invalidateStaleApprovals,
  parseClearanceState,
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
  findStickyComment(input: PullRequestWorkflowInput): Promise<{ body?: string } | undefined>;
  listChangedFiles(input: PullRequestWorkflowInput): Promise<string[]>;
  listReviewerSignals(
    input: PullRequestWorkflowInput,
    reviewers: string[],
    changedFiles: string[],
  ): Promise<ReviewerSignal[]>;
  loadOwnershipTree(input: PullRequestWorkflowInput): Promise<OwnershipTree>;
  requestReviewers(input: PullRequestWorkflowInput, reviewers: string[]): Promise<void>;
  resolveIdentities(tree: OwnershipTree): Promise<GithubIdentityResolution>;
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
  ownershipResolution: OwnershipResolution;
  ownershipTree: OwnershipTree;
};

export async function processPullRequestChange(
  input: PullRequestWorkflowInput,
  dependencies: PullRequestWorkflowDependencies,
): Promise<PullRequestWorkflowResult> {
  const context = await buildWorkflowContext(input, dependencies);
  const previousState = parseClearanceState(
    (await dependencies.findStickyComment(input))?.body,
  ).state;
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
  const assignmentRecords = buildAssignmentRecords(
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
  const override = evaluateWorkflowOverride(input, context);
  const finalState =
    override.active === true
      ? {
          ...state,
          override: {
            actor: override.actor,
            at: input.now,
            label: override.label,
          },
        }
      : state;
  const checks = createWorkflowChecks(context, finalState, override.active === true);
  const pendingNotifications =
    context.configValid && override.active !== true
      ? getPendingNotifications(baseState, context.ownershipResolution.notifications)
      : [];
  const requestedReviewers =
    context.configValid && override.active !== true
      ? getNewAssignmentReviewers(baseState.assignments, assignmentRecords)
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

  const sideEffectFailures = await runWorkflowSideEffects([
    {
      execute: () =>
        dependencies.upsertComment(input, renderClearanceComment(finalStateWithNotifications)),
      operation: "upsert-comment",
    },
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
  const previousState = parseClearanceState(
    (await dependencies.findStickyComment(input))?.body,
  ).state;
  const state = recordSubmittedReview(previousState, {
    approvedAt: input.now,
    definitions: context.definitions,
    headSha: input.headSha,
    reviewer: input.reviewer,
    state: input.reviewState,
  });
  const checks = createWorkflowChecks(context, state, state.override !== undefined);

  const sideEffectFailures = await runWorkflowSideEffects([
    {
      execute: () => dependencies.upsertComment(input, renderClearanceComment(state)),
      operation: "upsert-comment",
    },
    {
      execute: () => dependencies.setStatuses(input, checks),
      operation: "set-statuses",
    },
  ]);

  return {
    changedFiles: context.changedFiles,
    checks,
    sideEffectFailures,
    requestedReviewers: [],
    state,
  };
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

    return {
      ...policy,
      assignedReviewers: selectedAssignment?.reviewers ?? [],
      eligibleReviewers:
        selectedOption === undefined
          ? []
          : getCandidateLogins(candidatesByActor, selectedOption.from),
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
): string[] {
  const existingRequirementIdentities = new Set(
    existingAssignments.map((assignment) => assignment.requirementIdentity),
  );

  return [
    ...new Set(
      assignmentRecords
        .filter((assignment) => !existingRequirementIdentities.has(assignment.requirementIdentity))
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

function evaluateWorkflowOverride(input: PullRequestWorkflowInput, context: WorkflowContext) {
  return evaluateOverride({
    actor: input.sender,
    at: input.now,
    configValid: context.configValid,
    labels: input.labels,
    ownershipFiles: context.ownershipTree.files,
    teamMembersByActor: new Map(
      [...context.identityResolution.teams.entries()].map(([actor, team]) => [
        actor,
        team.members.map((member) => member.login),
      ]),
    ),
  });
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
  effects: Array<{
    execute(): Promise<void>;
    operation: WorkflowSideEffectFailure["operation"];
  }>,
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
