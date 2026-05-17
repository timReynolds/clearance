import type { OwnershipFile } from "../owners/index.js";
import type { StateEvent } from "../state/index.js";

export type TeamMembersByActor = Map<string, string[]> | Record<string, string[]>;

export type OverrideInput = {
  actor: string;
  at: string;
  configValid: boolean;
  labels: string[];
  ownershipFiles: OwnershipFile[];
  teamMembersByActor: TeamMembersByActor;
};

export type OverrideEvaluation =
  | {
      active: true;
      actor: string;
      auditEvent: StateEvent;
      label: string;
      team: string;
    }
  | {
      active: false;
      reason: string;
    };

export function evaluateOverride(input: OverrideInput): OverrideEvaluation {
  if (!input.configValid) {
    return {
      active: false,
      reason: "invalid OWNERS.toml configuration cannot be bypassed by override",
    };
  }

  const overrideConfig = input.ownershipFiles
    .map((file) => file.config?.override)
    .find((override) => override !== undefined);
  if (overrideConfig === undefined) {
    return {
      active: false,
      reason: "no override is configured",
    };
  }

  if (!input.labels.includes(overrideConfig.label)) {
    return {
      active: false,
      reason: `override label ${overrideConfig.label} is not present`,
    };
  }

  const teamMembersByActor = normalizeTeamMembers(input.teamMembersByActor);
  const authorizedTeam = overrideConfig.teams.find((team) =>
    (teamMembersByActor.get(team) ?? []).includes(input.actor),
  );
  if (authorizedTeam === undefined) {
    return {
      active: false,
      reason: `actor ${input.actor} is not a member of an override team`,
    };
  }

  return {
    active: true,
    actor: input.actor,
    auditEvent: {
      actor: input.actor,
      at: input.at,
      message: `Override activated with label ${overrideConfig.label}`,
      type: "override",
    },
    label: overrideConfig.label,
    team: authorizedTeam,
  };
}

function normalizeTeamMembers(teamMembersByActor: TeamMembersByActor): Map<string, string[]> {
  if (teamMembersByActor instanceof Map) {
    return teamMembersByActor;
  }

  return new Map(Object.entries(teamMembersByActor));
}
