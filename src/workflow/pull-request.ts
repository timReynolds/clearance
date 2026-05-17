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
import { resolveOwnership, type OwnershipResolution } from "../resolution/index.js";
import {
  invalidateStaleApprovals,
  parseClearanceState,
  rebuildReviewState,
  recordSubmittedReview,
  renderClearanceComment,
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
  loadOwnershipTree(input: PullRequestWorkflowInput): Promise<OwnershipTree>;
  requestReviewers(input: PullRequestWorkflowInput, reviewers: string[]): Promise<void>;
  resolveIdentities(tree: OwnershipTree): Promise<GithubIdentityResolution>;
  setStatuses(input: PullRequestWorkflowInput, decisions: CheckDecision[]): Promise<void>;
  upsertComment(input: PullRequestWorkflowInput, body: string): Promise<void>;
};

export type PullRequestWorkflowResult = {
  changedFiles: string[];
  checks: CheckDecision[];
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
          previousState,
        })
      : invalidateStaleApprovals(previousState, {
          changedFiles: input.changedFilesSinceLastApproval,
          definitions: context.definitions,
          headSha: input.headSha,
        });
  const state = {
    ...baseState,
    warnings: context.reviewerAssignments.warnings.map((message) => ({ message })),
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
  const requestedReviewers =
    context.configValid && override.active !== true
      ? context.reviewerAssignments.assignments.flatMap((assignment) => assignment.reviewers)
      : [];

  await Promise.all([
    dependencies.upsertComment(input, renderClearanceComment(finalState)),
    dependencies.setStatuses(input, checks),
    dependencies.requestReviewers(input, requestedReviewers),
  ]);

  return {
    changedFiles: context.changedFiles,
    checks,
    requestedReviewers,
    state: finalState,
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

  await Promise.all([
    dependencies.upsertComment(input, renderClearanceComment(state)),
    dependencies.setStatuses(input, checks),
  ]);

  return {
    changedFiles: context.changedFiles,
    checks,
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
  const candidatesByActor = buildCandidatesByActor(identityResolution);
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
): Map<string, ReviewerCandidate[]> {
  const candidatesByActor = new Map<string, ReviewerCandidate[]>();

  for (const [actor, user] of identityResolution.users) {
    candidatesByActor.set(actor, [{ id: user.id, login: user.login }]);
  }

  for (const [actor, team] of identityResolution.teams) {
    candidatesByActor.set(
      actor,
      team.members.map((member) => ({
        id: member.id,
        login: member.login,
      })),
    );
  }

  return candidatesByActor;
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
): ReviewRequirementDefinition[] {
  return assignmentRequirements.map((requirement) => {
    if (requirement.type === "and") {
      const resolvedRequirement = resolution.andRequirements.find(
        (andRequirement) => andRequirement.identity === requirement.identity,
      );

      return {
        eligibleReviewers: getCandidateLogins(candidatesByActor, requirement.from),
        identity: requirement.identity,
        label: `${requirement.from} approval`,
        relevantFiles: getRelevantFiles(resolvedRequirement?.triggers ?? []),
        requiredCount: requirement.count,
        type: requirement.type,
      };
    }

    const selectedAssignment = reviewerAssignments.find(
      (assignment) => assignment.requirementIdentity === requirement.identity,
    );
    const selectedOption = requirement.options.find(
      (option) => option.from === selectedAssignment?.actor,
    );
    const resolvedRequirement = resolution.orRequirements.find(
      (orRequirement) => orRequirement.identity === requirement.identity,
    );

    return {
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

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
