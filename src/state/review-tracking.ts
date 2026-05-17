import {
  createEmptyClearanceState,
  type ApprovalRecord,
  type ClearanceState,
  type ClearanceStateRequirement,
} from "./state.js";

export type ReviewRequirementDefinition = {
  eligibleReviewers: string[];
  identity: string;
  label: string;
  relevantFiles: string[];
  requiredCount: number;
  type: "and" | "or";
};

export type RebuildReviewStateInput = {
  definitions: ReviewRequirementDefinition[];
  headSha: string;
  previousState?: ClearanceState;
};

export type SubmittedReviewInput = {
  approvedAt: string;
  definitions: ReviewRequirementDefinition[];
  headSha: string;
  reviewer: string;
  state: string;
};

export type ScopedInvalidationInput = {
  changedFiles: string[];
  definitions: ReviewRequirementDefinition[];
  headSha: string;
};

export function rebuildReviewState(input: RebuildReviewStateInput): ClearanceState {
  const previousState = input.previousState ?? createEmptyClearanceState();
  const requirements = input.definitions.map((definition) =>
    buildRequirementState(
      definition,
      previousState.approvals.filter(
        (approval) =>
          approval.requirementIdentity === definition.identity &&
          approval.headSha === input.headSha,
      ),
      input.headSha,
    ),
  );
  const requirementIdentities = new Set(input.definitions.map((definition) => definition.identity));

  return {
    ...previousState,
    approvals: previousState.approvals.filter((approval) =>
      requirementIdentities.has(approval.requirementIdentity),
    ),
    assignments: previousState.assignments.filter((assignment) =>
      requirementIdentities.has(assignment.requirementIdentity),
    ),
    requirements,
  };
}

export function recordSubmittedReview(
  state: ClearanceState,
  input: SubmittedReviewInput,
): ClearanceState {
  if (input.state.toUpperCase() !== "APPROVED") {
    return state;
  }

  const matchingDefinitions = input.definitions.filter((definition) =>
    definition.eligibleReviewers.includes(input.reviewer),
  );
  if (matchingDefinitions.length === 0) {
    return state;
  }

  const newApprovals = matchingDefinitions.map((definition): ApprovalRecord => {
    return {
      approvedAt: input.approvedAt,
      headSha: input.headSha,
      requirementIdentity: definition.identity,
      reviewer: input.reviewer,
    };
  });
  const replacedApprovals = [
    ...state.approvals.filter(
      (approval) =>
        !newApprovals.some(
          (newApproval) =>
            newApproval.requirementIdentity === approval.requirementIdentity &&
            newApproval.reviewer === approval.reviewer,
        ),
    ),
    ...newApprovals,
  ];

  return rebuildReviewState({
    definitions: input.definitions,
    headSha: input.headSha,
    previousState: {
      ...state,
      approvals: replacedApprovals,
    },
  });
}

export function invalidateStaleApprovals(
  state: ClearanceState,
  input: ScopedInvalidationInput,
): ClearanceState {
  const changedFiles = new Set(input.changedFiles);
  const staleRequirementIdentities = new Set(
    input.definitions
      .filter((definition) => definition.relevantFiles.some((file) => changedFiles.has(file)))
      .map((definition) => definition.identity),
  );
  const retainedApprovals = state.approvals.filter(
    (approval) => !staleRequirementIdentities.has(approval.requirementIdentity),
  );
  const requirements = input.definitions.map((definition) => {
    const approvals = retainedApprovals.filter(
      (approval) => approval.requirementIdentity === definition.identity,
    );

    return buildRequirementState(definition, approvals, getApprovedHeadSha(approvals));
  });
  const requirementIdentities = new Set(input.definitions.map((definition) => definition.identity));

  return {
    ...state,
    approvals: retainedApprovals,
    assignments: state.assignments.filter((assignment) =>
      requirementIdentities.has(assignment.requirementIdentity),
    ),
    requirements,
  };
}

function buildRequirementState(
  definition: ReviewRequirementDefinition,
  approvals: ApprovalRecord[],
  approvedHeadSha: string | undefined,
): ClearanceStateRequirement {
  const approvedBy = approvals
    .filter((approval) => definition.eligibleReviewers.includes(approval.reviewer))
    .map((approval) => approval.reviewer)
    .toSorted(compareStrings);
  const status = approvedBy.length >= definition.requiredCount ? "approved" : "pending";

  return {
    approvedBy,
    approvedHeadSha: status === "approved" ? approvedHeadSha : undefined,
    identity: definition.identity,
    label: definition.label,
    relevantFiles: definition.relevantFiles,
    requiredCount: definition.requiredCount,
    status,
    type: definition.type,
  };
}

function getApprovedHeadSha(approvals: ApprovalRecord[]): string | undefined {
  return approvals.toSorted((left, right) => compareStrings(right.approvedAt, left.approvedAt))[0]
    ?.headSha;
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
