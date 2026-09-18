import type { RequirementOption } from "../resolution/index.js";

export type ReviewerCandidate = {
  blameCoverage?: number;
  currentLoad?: number;
  id?: number;
  login: string;
  reviewHistory?: number;
  roundRobinRank?: number;
  unavailable?: boolean;
};

export type AssignmentRequirement =
  | {
      count: number;
      from: string;
      identity: string;
      type: "and";
    }
  | {
      identity: string;
      options: RequirementOption[];
      type: "or";
    };

export type ReviewerScore = {
  blameScore: number;
  currentLoadScore: number;
  login: string;
  reviewHistoryScore: number;
  roundRobinScore: number;
  totalScore: number;
};

export type ReviewerAssignment = {
  actor: string;
  requirementIdentity: string;
  reviewers: string[];
  scores: ReviewerScore[];
  type: "and" | "or";
  warnings: string[];
};

export type AssignmentInput = {
  author: string;
  candidatesByActor: Map<string, ReviewerCandidate[]> | Record<string, ReviewerCandidate[]>;
  requirements: AssignmentRequirement[];
};

export type AssignmentResult = {
  assignments: ReviewerAssignment[];
  warnings: string[];
};

export function assignReviewers(input: AssignmentInput): AssignmentResult {
  const candidatesByActor = normalizeCandidateMap(input.candidatesByActor);
  const assignments = input.requirements.map((requirement) =>
    assignRequirement(requirement, candidatesByActor, input.author),
  );

  return {
    assignments,
    warnings: assignments.flatMap((assignment) => assignment.warnings),
  };
}

function assignRequirement(
  requirement: AssignmentRequirement,
  candidatesByActor: Map<string, ReviewerCandidate[]>,
  author: string,
): ReviewerAssignment {
  if (requirement.type === "and") {
    return assignActorRequirement({
      actor: requirement.from,
      author,
      candidates: candidatesByActor.get(requirement.from) ?? [],
      count: requirement.count,
      requirementIdentity: requirement.identity,
      type: "and",
    });
  }

  if (requirement.options.length === 0) {
    return {
      actor: "",
      requirementIdentity: requirement.identity,
      reviewers: [],
      scores: [],
      type: "or",
      warnings: [`Requirement ${requirement.identity} has no reviewer options`],
    };
  }

  const selectedOption = chooseOrOption(requirement.options, candidatesByActor, author);
  return assignActorRequirement({
    actor: selectedOption.from,
    author,
    candidates: candidatesByActor.get(selectedOption.from) ?? [],
    count: selectedOption.count,
    requirementIdentity: requirement.identity,
    type: "or",
  });
}

function assignActorRequirement(parameters: {
  actor: string;
  author: string;
  candidates: ReviewerCandidate[];
  count: number;
  requirementIdentity: string;
  type: "and" | "or";
}): ReviewerAssignment {
  const rankedCandidates = rankCandidates(parameters.candidates, parameters.author);
  const selected = rankedCandidates.slice(0, parameters.count);
  const warnings =
    selected.length < parameters.count
      ? [
          `Requirement ${parameters.requirementIdentity} requested ${parameters.count} reviewer${parameters.count === 1 ? "" : "s"} from ${parameters.actor}, but only ${selected.length} eligible reviewer${selected.length === 1 ? "" : "s"} ${selected.length === 1 ? "was" : "were"} available`,
        ]
      : [];

  return {
    actor: parameters.actor,
    requirementIdentity: parameters.requirementIdentity,
    reviewers: selected.map((candidate) => candidate.login),
    scores: selected,
    type: parameters.type,
    warnings,
  };
}

function chooseOrOption(
  options: RequirementOption[],
  candidatesByActor: Map<string, ReviewerCandidate[]>,
  author: string,
): RequirementOption {
  const rankedOptions = options
    .map((option) => {
      const rankedCandidates = rankCandidates(candidatesByActor.get(option.from) ?? [], author);
      const selected = rankedCandidates.slice(0, option.count);
      const aggregateScore =
        selected.length === 0
          ? 0
          : selected.reduce((sum, candidate) => sum + candidate.totalScore, 0) / option.count;

      return {
        aggregateScore,
        eligibleCount: rankedCandidates.length,
        option,
      };
    })
    .toSorted((left, right) => {
      const scoreComparison = right.aggregateScore - left.aggregateScore;
      if (scoreComparison !== 0) {
        return scoreComparison;
      }

      const countComparison = right.eligibleCount - left.eligibleCount;
      if (countComparison !== 0) {
        return countComparison;
      }

      return compareStrings(left.option.from, right.option.from);
    });

  return rankedOptions[0]?.option ?? { count: 1, from: "" };
}

function rankCandidates(candidates: ReviewerCandidate[], author: string): ReviewerScore[] {
  return candidates
    .filter((candidate) => candidate.login !== author && candidate.unavailable !== true)
    .map((candidate) => scoreCandidate(candidate))
    .toSorted((left, right) => {
      const scoreComparison = right.totalScore - left.totalScore;
      if (scoreComparison !== 0) {
        return scoreComparison;
      }

      return compareStrings(left.login, right.login);
    });
}

function scoreCandidate(candidate: ReviewerCandidate): ReviewerScore {
  const blameScore = clampUnit(candidate.blameCoverage ?? 0);
  const reviewHistoryScore = clampUnit(candidate.reviewHistory ?? 0);
  const currentLoadScore = 1 / (1 + Math.max(0, candidate.currentLoad ?? 0));
  const roundRobinScore = 1 / (1 + Math.max(0, candidate.roundRobinRank ?? 0));
  const totalScore =
    0.4 * blameScore + 0.3 * reviewHistoryScore + 0.2 * currentLoadScore + 0.1 * roundRobinScore;

  return {
    blameScore,
    currentLoadScore,
    login: candidate.login,
    reviewHistoryScore,
    roundRobinScore,
    totalScore,
  };
}

function normalizeCandidateMap(
  candidatesByActor: Map<string, ReviewerCandidate[]> | Record<string, ReviewerCandidate[]>,
): Map<string, ReviewerCandidate[]> {
  if (candidatesByActor instanceof Map) {
    return candidatesByActor;
  }

  return new Map(Object.entries(candidatesByActor));
}

function clampUnit(value: number): number {
  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
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
