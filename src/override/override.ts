import type { OwnershipFile } from "../owners/index.js";
import type { StateEvent } from "../state/index.js";

export type TeamMembersByActor = Map<string, string[]> | Record<string, string[]>;

export type OverrideInput = {
  actor: string;
  at: string;
  command: OverrideCommand;
  configValid: boolean;
  ownershipFiles: OwnershipFile[];
  teamMembersByActor: TeamMembersByActor;
};

export type OverrideCommand =
  | {
      commentId?: number;
      type: "activate";
    }
  | {
      commentId?: number;
      type: "revoke";
    };

export type OverrideEvaluation =
  | {
      actor: string;
      auditEvent: StateEvent;
      commentId?: number;
      team: string;
      type: "activate" | "revoke";
    }
  | {
      reason: string;
      type: "rejected";
    };

export function evaluateOverride(input: OverrideInput): OverrideEvaluation {
  if (!input.configValid) {
    return {
      reason: "invalid OWNERS.toml configuration cannot be bypassed by override",
      type: "rejected",
    };
  }

  const overrideConfig = input.ownershipFiles
    .map((file) => file.config?.override)
    .find((override) => override !== undefined);
  if (overrideConfig === undefined) {
    return {
      reason: "no override is configured",
      type: "rejected",
    };
  }

  const teamMembersByActor = normalizeTeamMembers(input.teamMembersByActor);
  const authorizedTeam = overrideConfig.teams.find((team) =>
    (teamMembersByActor.get(team) ?? []).includes(input.actor),
  );
  if (authorizedTeam === undefined) {
    return {
      reason: `actor ${input.actor} is not a member of an override team`,
      type: "rejected",
    };
  }

  const action = input.command.type === "activate" ? "activated" : "revoked";
  return {
    actor: input.actor,
    auditEvent: {
      actor: input.actor,
      at: input.at,
      message: `Override ${action} by @clearance override command`,
      type: "override",
    },
    commentId: input.command.commentId,
    team: authorizedTeam,
    type: input.command.type,
  };
}

export function parseOverrideCommentCommand(body: string): OverrideCommand | undefined {
  const command = body.trim().match(/^@clearance\s+override(?:\s+(?<action>revoke))?\b/i);
  if (command === null) {
    return undefined;
  }

  return command.groups?.action?.toLowerCase() === "revoke"
    ? { type: "revoke" }
    : { type: "activate" };
}

function normalizeTeamMembers(teamMembersByActor: TeamMembersByActor): Map<string, string[]> {
  if (teamMembersByActor instanceof Map) {
    return teamMembersByActor;
  }

  return new Map(Object.entries(teamMembersByActor));
}
