import type { OwnersConfig, OwnersDiagnostic, OwnershipFile } from "../owners/index.js";

type RequirementConfig = OwnersConfig["rule"][number]["require"][number];

export type GithubIdentityOctokit = {
  rest: {
    teams: {
      getByName(parameters: { org: string; team_slug: string }): Promise<{
        data: {
          id?: number;
          name?: string;
          slug: string;
        };
      }>;
      listMembersInOrg(parameters: {
        org: string;
        page?: number;
        per_page?: number;
        team_slug: string;
      }): Promise<{
        data: Array<{
          id?: number;
          login: string;
          type?: string;
        }>;
      }>;
    };
    users: {
      getByUsername(parameters: { username: string }): Promise<{
        data: {
          id?: number;
          login: string;
          type?: string;
        };
      }>;
    };
  };
};

export type ResolvedGithubUser = {
  actor: string;
  id?: number;
  login: string;
  type: "user";
};

export type CandidateReviewer = {
  id?: number;
  login: string;
};

export type ResolvedGithubTeam = {
  actor: string;
  id?: number;
  members: CandidateReviewer[];
  name?: string;
  org: string;
  slug: string;
  type: "team";
};

export type GithubIdentityResolution = {
  candidateReviewersByTeam: Map<string, CandidateReviewer[]>;
  diagnostics: OwnersDiagnostic[];
  teams: Map<string, ResolvedGithubTeam>;
  users: Map<string, ResolvedGithubUser>;
};

type ActorReferenceKind = "requirement" | "team" | "user";

type ActorReference = {
  actor: string;
  count?: number;
  filePath: string;
  kind: ActorReferenceKind;
  schemaPath: string;
};

type ResolvedActorReference = {
  diagnostics: OwnersDiagnostic[];
  reference: ActorReference;
  team?: ResolvedGithubTeam;
  user?: ResolvedGithubUser;
};

type ParsedActor =
  | {
      actor: string;
      login: string;
      type: "user";
    }
  | {
      actor: string;
      org: string;
      slug: string;
      type: "team";
    };

type LookupResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      message: string;
      ok: false;
    };

export class GithubIdentityResolver {
  private readonly teams = new Map<string, Promise<LookupResult<ResolvedGithubTeam>>>();
  private readonly users = new Map<string, Promise<LookupResult<ResolvedGithubUser>>>();

  constructor(private readonly octokit: GithubIdentityOctokit) {}

  async resolveOwnershipFiles(files: OwnershipFile[]): Promise<GithubIdentityResolution> {
    const references = collectActorReferences(files);
    const diagnostics: OwnersDiagnostic[] = [];
    const users = new Map<string, ResolvedGithubUser>();
    const teams = new Map<string, ResolvedGithubTeam>();
    const resolvedReferences = await Promise.all(
      references.map((reference) => this.resolveReference(reference)),
    );

    for (const resolvedReference of resolvedReferences) {
      diagnostics.push(...resolvedReference.diagnostics);

      if (resolvedReference.user !== undefined) {
        users.set(resolvedReference.reference.actor, resolvedReference.user);
        continue;
      }

      if (resolvedReference.team !== undefined) {
        teams.set(resolvedReference.reference.actor, resolvedReference.team);
      }
    }

    return {
      candidateReviewersByTeam: new Map(
        [...teams.entries()].map(([actor, team]) => [actor, team.members]),
      ),
      diagnostics,
      teams,
      users,
    };
  }

  private async resolveReference(reference: ActorReference): Promise<ResolvedActorReference> {
    const parsedActor = parseActor(reference.actor);
    if (parsedActor === undefined) {
      return {
        diagnostics: [
          buildDiagnostic(reference, `invalid GitHub actor reference ${reference.actor}`),
        ],
        reference,
      };
    }

    if (parsedActor.type === "user") {
      const user = await this.resolveUser(parsedActor);
      if (!user.ok) {
        return {
          diagnostics: [buildDiagnostic(reference, user.message)],
          reference,
        };
      }

      const diagnostics: OwnersDiagnostic[] = [];
      if (
        reference.kind === "requirement" &&
        reference.count !== undefined &&
        reference.count > 1
      ) {
        diagnostics.push(
          buildDiagnostic(
            reference,
            `requirement requests ${reference.count} approvals from user ${reference.actor}, but a user can provide at most 1`,
            "warning",
          ),
        );
      }

      return {
        diagnostics,
        reference,
        user: user.value,
      };
    }

    const team = await this.resolveTeam(parsedActor);
    if (!team.ok) {
      return {
        diagnostics: [buildDiagnostic(reference, team.message)],
        reference,
      };
    }

    const diagnostics: OwnersDiagnostic[] = [];
    if (team.value.members.length === 0) {
      diagnostics.push(
        buildDiagnostic(reference, `GitHub team ${reference.actor} has no members`, "warning"),
      );
    } else if (
      reference.kind === "requirement" &&
      reference.count !== undefined &&
      reference.count > team.value.members.length
    ) {
      diagnostics.push(
        buildDiagnostic(
          reference,
          `requirement requests ${reference.count} approvals from ${reference.actor}, but only ${team.value.members.length} team members were found`,
          "warning",
        ),
      );
    }

    return {
      diagnostics,
      reference,
      team: team.value,
    };
  }

  private async resolveUser(
    actor: Extract<ParsedActor, { type: "user" }>,
  ): Promise<LookupResult<ResolvedGithubUser>> {
    const cached = this.users.get(actor.actor);
    if (cached !== undefined) {
      return cached;
    }

    const lookup = this.octokit.rest.users
      .getByUsername({
        username: actor.login,
      })
      .then((response): ResolvedGithubUser => {
        return {
          actor: actor.actor,
          id: response.data.id,
          login: response.data.login,
          type: "user",
        };
      })
      .then((value): LookupResult<ResolvedGithubUser> => ({ ok: true, value }))
      .catch((error: unknown): LookupResult<ResolvedGithubUser> => {
        return {
          message: isNotFoundError(error)
            ? `GitHub user ${actor.actor} was not found`
            : `failed to resolve GitHub user ${actor.actor}: ${getErrorMessage(error, "unknown error")}`,
          ok: false,
        };
      });

    this.users.set(actor.actor, lookup);
    return lookup;
  }

  private async resolveTeam(
    actor: Extract<ParsedActor, { type: "team" }>,
  ): Promise<LookupResult<ResolvedGithubTeam>> {
    const cached = this.teams.get(actor.actor);
    if (cached !== undefined) {
      return cached;
    }

    const lookup = this.octokit.rest.teams
      .getByName({
        org: actor.org,
        team_slug: actor.slug,
      })
      .then(async (response): Promise<ResolvedGithubTeam> => {
        return {
          actor: actor.actor,
          id: response.data.id,
          members: await this.listTeamMembers(actor),
          name: response.data.name,
          org: actor.org,
          slug: response.data.slug,
          type: "team",
        };
      })
      .then((value): LookupResult<ResolvedGithubTeam> => ({ ok: true, value }))
      .catch((error: unknown): LookupResult<ResolvedGithubTeam> => {
        return {
          message: isNotFoundError(error)
            ? `GitHub team ${actor.actor} was not found`
            : `failed to resolve GitHub team ${actor.actor}: ${getErrorMessage(error, "unknown error")}`,
          ok: false,
        };
      });

    this.teams.set(actor.actor, lookup);
    return lookup;
  }

  private async listTeamMembers(
    actor: Extract<ParsedActor, { type: "team" }>,
    page = 1,
    members: CandidateReviewer[] = [],
  ): Promise<CandidateReviewer[]> {
    const response = await this.octokit.rest.teams.listMembersInOrg({
      org: actor.org,
      page,
      per_page: 100,
      team_slug: actor.slug,
    });
    const nextMembers = [
      ...members,
      ...response.data.map((member) => ({
        id: member.id,
        login: member.login,
      })),
    ];

    if (response.data.length < 100) {
      return nextMembers.toSorted((left, right) => compareStrings(left.login, right.login));
    }

    return this.listTeamMembers(actor, page + 1, nextMembers);
  }
}

export function createGithubIdentityResolver(
  octokit: GithubIdentityOctokit,
): GithubIdentityResolver {
  return new GithubIdentityResolver(octokit);
}

export async function resolveGithubIdentities(
  octokit: GithubIdentityOctokit,
  files: OwnershipFile[],
): Promise<GithubIdentityResolution> {
  return createGithubIdentityResolver(octokit).resolveOwnershipFiles(files);
}

function collectActorReferences(files: OwnershipFile[]): ActorReference[] {
  return files.flatMap((file) => {
    if (file.config === undefined) {
      return [];
    }

    return collectConfigActorReferences(file.path, file.config);
  });
}

function collectConfigActorReferences(filePath: string, config: OwnersConfig): ActorReference[] {
  const references: ActorReference[] = [];

  if (config.escalation?.fallback_team !== undefined) {
    references.push({
      actor: config.escalation.fallback_team,
      filePath,
      kind: "team",
      schemaPath: "$.escalation.fallback_team",
    });
  }

  for (const [ruleIndex, rule] of config.rule.entries()) {
    collectRequirementReferences(
      filePath,
      references,
      rule.require,
      `$.rule[${ruleIndex}].require`,
    );
    collectRequirementReferences(
      filePath,
      references,
      rule.require_any,
      `$.rule[${ruleIndex}].require_any`,
    );

    if (rule.escalation?.fallback_team !== undefined) {
      references.push({
        actor: rule.escalation.fallback_team,
        filePath,
        kind: "team",
        schemaPath: `$.rule[${ruleIndex}].escalation.fallback_team`,
      });
    }
  }

  for (const [notifyIndex, notification] of config.notify.entries()) {
    for (const [teamIndex, team] of notification.teams.entries()) {
      references.push({
        actor: team,
        filePath,
        kind: "team",
        schemaPath: `$.notify[${notifyIndex}].teams[${teamIndex}]`,
      });
    }

    for (const [userIndex, user] of notification.users.entries()) {
      references.push({
        actor: user,
        filePath,
        kind: "user",
        schemaPath: `$.notify[${notifyIndex}].users[${userIndex}]`,
      });
    }
  }

  if (config.override !== undefined) {
    for (const [teamIndex, team] of config.override.teams.entries()) {
      references.push({
        actor: team,
        filePath,
        kind: "team",
        schemaPath: `$.override.teams[${teamIndex}]`,
      });
    }
  }

  return references;
}

function collectRequirementReferences(
  filePath: string,
  references: ActorReference[],
  requirements: RequirementConfig[],
  schemaPath: string,
): void {
  for (const [requirementIndex, requirement] of requirements.entries()) {
    references.push({
      actor: requirement.from,
      count: requirement.count,
      filePath,
      kind: "requirement",
      schemaPath: `${schemaPath}[${requirementIndex}].from`,
    });
  }
}

function parseActor(actor: string): ParsedActor | undefined {
  const match = /^@(?<owner>[A-Za-z0-9_.-]+)(?:\/(?<team>[A-Za-z0-9_.-]+))?$/.exec(actor);
  if (match?.groups === undefined) {
    return undefined;
  }

  const owner = match.groups.owner;
  const team = match.groups.team;
  if (owner === undefined) {
    return undefined;
  }

  if (team === undefined) {
    return {
      actor,
      login: owner,
      type: "user",
    };
  }

  return {
    actor,
    org: owner,
    slug: team,
    type: "team",
  };
}

function buildDiagnostic(
  reference: ActorReference,
  message: string,
  severity: OwnersDiagnostic["severity"] = "error",
): OwnersDiagnostic {
  return {
    filePath: reference.filePath,
    message,
    schemaPath: reference.schemaPath,
    severity,
  };
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

function isNotFoundError(error: unknown): boolean {
  return getErrorStatus(error) === 404;
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }

  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
