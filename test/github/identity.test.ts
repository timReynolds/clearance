import { describe, expect, it, vi } from "vitest";

import { resolveGithubIdentities, type GithubIdentityOctokit } from "../../src/github/index.js";
import { parseOwnersToml, type OwnershipFile } from "../../src/owners/index.js";

type UserLookup = GithubIdentityOctokit["rest"]["users"]["getByUsername"];
type TeamLookup = GithubIdentityOctokit["rest"]["teams"]["getByName"];
type MemberLookup = GithubIdentityOctokit["rest"]["teams"]["listMembersInOrg"];

describe("resolveGithubIdentities", () => {
  it("resolves users, teams, fallback teams, notifications, and override teams", async () => {
    const octokit = createIdentityOctokitMock({
      teams: {
        "@org/admins": {
          id: 4,
          members: ["zoe"],
          name: "Admins",
          slug: "admins",
        },
        "@org/platform": {
          id: 1,
          members: ["carol", "bob"],
          name: "Platform",
          slug: "platform",
        },
        "@org/security": {
          id: 2,
          members: ["frank"],
          name: "Security",
          slug: "security",
        },
      },
      users: {
        "@alice": {
          id: 10,
          login: "alice",
        },
      },
    });

    const result = await resolveGithubIdentities(octokit, [
      ownershipFile(
        "OWNERS.toml",
        `
[escalation]
fallback_team = "@org/platform"

[[rule]]
paths = ["**"]
require = [
  { from = "@org/platform", count = 2 },
  { from = "@alice", count = 1 },
]
require_any = [
  { from = "@org/security", count = 1 },
]
escalation = { fallback_team = "@org/platform" }

[[notify]]
paths = ["**"]
teams = ["@org/platform"]
users = ["@alice"]

[override]
teams = ["@org/admins"]
label = "clearance-override"
`,
      ),
    ]);

    expect(result.diagnostics).toEqual([]);
    expect([...result.users.keys()]).toEqual(["@alice"]);
    expect([...result.teams.keys()]).toEqual(["@org/platform", "@org/security", "@org/admins"]);
    expect(result.users.get("@alice")).toEqual({
      actor: "@alice",
      id: 10,
      login: "alice",
      type: "user",
    });
    expect(result.teams.get("@org/platform")).toEqual({
      actor: "@org/platform",
      id: 1,
      members: [
        { id: 102, login: "bob" },
        { id: 101, login: "carol" },
      ],
      name: "Platform",
      org: "org",
      slug: "platform",
      type: "team",
    });
    expect(result.candidateReviewersByTeam.get("@org/platform")).toEqual([
      { id: 102, login: "bob" },
      { id: 101, login: "carol" },
    ]);
    expect(octokit.rest.users.getByUsername).toHaveBeenCalledTimes(1);
    expect(octokit.rest.teams.getByName).toHaveBeenCalledTimes(3);
    expect(octokit.rest.teams.listMembersInOrg).toHaveBeenCalledTimes(3);
  });

  it("surfaces missing users and teams with config schema paths", async () => {
    const octokit = createIdentityOctokitMock({
      missingTeams: new Set(["@org/missing", "@org/missing-notify"]),
      missingUsers: new Set(["@missing", "@missing-notify"]),
      teams: {},
      users: {},
    });

    const result = await resolveGithubIdentities(octokit, [
      ownershipFile(
        "services/api/OWNERS.toml",
        `
[[rule]]
paths = ["**"]
require = [{ from = "@missing", count = 1 }]
require_any = [{ from = "@org/missing", count = 1 }]

[[notify]]
paths = ["**"]
teams = ["@org/missing-notify"]
users = ["@missing-notify"]
`,
      ),
    ]);

    expect(result.users).toEqual(new Map());
    expect(result.teams).toEqual(new Map());
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        filePath: "services/api/OWNERS.toml",
        message: "GitHub user @missing was not found",
        schemaPath: "$.rule[0].require[0].from",
        severity: "error",
      }),
      expect.objectContaining({
        filePath: "services/api/OWNERS.toml",
        message: "GitHub team @org/missing was not found",
        schemaPath: "$.rule[0].require_any[0].from",
        severity: "error",
      }),
      expect.objectContaining({
        message: "GitHub team @org/missing-notify was not found",
        schemaPath: "$.notify[0].teams[0]",
      }),
      expect.objectContaining({
        message: "GitHub user @missing-notify was not found",
        schemaPath: "$.notify[0].users[0]",
      }),
    ]);
  });

  it("warns for empty teams, infeasible team counts, and infeasible user counts", async () => {
    const octokit = createIdentityOctokitMock({
      teams: {
        "@org/empty": {
          id: 2,
          members: [],
          name: "Empty",
          slug: "empty",
        },
        "@org/tiny": {
          id: 1,
          members: ["bob", "carol"],
          name: "Tiny",
          slug: "tiny",
        },
      },
      users: {
        "@alice": {
          id: 10,
          login: "alice",
        },
      },
    });

    const result = await resolveGithubIdentities(octokit, [
      ownershipFile(
        "OWNERS.toml",
        `
[[rule]]
paths = ["**"]
require = [
  { from = "@org/tiny", count = 3 },
  { from = "@org/empty", count = 1 },
  { from = "@alice", count = 2 },
]
`,
      ),
    ]);

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        message:
          "requirement requests 3 approvals from @org/tiny, but only 2 team members were found",
        schemaPath: "$.rule[0].require[0].from",
        severity: "warning",
      }),
      expect.objectContaining({
        message: "GitHub team @org/empty has no members",
        schemaPath: "$.rule[0].require[1].from",
        severity: "warning",
      }),
      expect.objectContaining({
        message:
          "requirement requests 2 approvals from user @alice, but a user can provide at most 1",
        schemaPath: "$.rule[0].require[2].from",
        severity: "warning",
      }),
    ]);
  });

  it("paginates team members and reports non-404 lookup failures", async () => {
    const paginatedMembers = Array.from({ length: 101 }, (_, index) => `member-${index}`);
    const octokit = createIdentityOctokitMock({
      listMemberErrors: new Map([["@org/broken-members", new Error("members unavailable")]]),
      teams: {
        "@org/big": {
          id: 1,
          members: paginatedMembers,
          name: "Big",
          slug: "big",
        },
        "@org/broken-members": {
          id: 2,
          members: ["alice"],
          name: "Broken Members",
          slug: "broken-members",
        },
      },
      users: {},
    });

    const result = await resolveGithubIdentities(octokit, [
      ownershipFile(
        "OWNERS.toml",
        `
[[rule]]
paths = ["**"]
require = [
  { from = "@org/big", count = 1 },
  { from = "@org/broken-members", count = 1 },
]
`,
      ),
    ]);

    expect(result.teams.get("@org/big")?.members).toHaveLength(101);
    expect(result.teams.has("@org/broken-members")).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        message: "failed to resolve GitHub team @org/broken-members: members unavailable",
        schemaPath: "$.rule[0].require[1].from",
        severity: "error",
      }),
    ]);
    expect(octokit.rest.teams.listMembersInOrg).toHaveBeenCalledWith({
      org: "org",
      page: 1,
      per_page: 100,
      team_slug: "big",
    });
    expect(octokit.rest.teams.listMembersInOrg).toHaveBeenCalledWith({
      org: "org",
      page: 2,
      per_page: 100,
      team_slug: "big",
    });
  });
});

function ownershipFile(path: string, source: string): OwnershipFile {
  const parseResult = parseOwnersToml(source, { filePath: path });
  expect(parseResult.ok).toBe(true);
  if (!parseResult.ok) {
    throw new Error(parseResult.errors.join("\n"));
  }

  return {
    config: parseResult.config,
    diagnostics: [],
    directory: path === "OWNERS.toml" ? "." : path.replace(/\/OWNERS\.toml$/, ""),
    path,
    sha: `${path}-sha`,
  };
}

function createIdentityOctokitMock(options: {
  listMemberErrors?: Map<string, Error>;
  missingTeams?: Set<string>;
  missingUsers?: Set<string>;
  teams: Record<
    string,
    {
      id: number;
      members: string[];
      name: string;
      slug: string;
    }
  >;
  users: Record<
    string,
    {
      id: number;
      login: string;
    }
  >;
}): GithubIdentityOctokit {
  const getByUsername = vi.fn<UserLookup>(async ({ username }) => {
    const actor = `@${username}`;
    const user = options.users[actor];
    if (user === undefined || options.missingUsers?.has(actor)) {
      throw httpError(404, "not found");
    }

    return {
      data: {
        id: user.id,
        login: user.login,
        type: "User",
      },
    };
  });
  const getByName = vi.fn<TeamLookup>(async ({ org, team_slug }) => {
    const actor = `@${org}/${team_slug}`;
    const team = options.teams[actor];
    if (team === undefined || options.missingTeams?.has(actor)) {
      throw httpError(404, "not found");
    }

    return {
      data: {
        id: team.id,
        name: team.name,
        slug: team.slug,
      },
    };
  });
  const listMembersInOrg = vi.fn<MemberLookup>(
    async ({ org, page = 1, per_page = 100, team_slug }) => {
      const actor = `@${org}/${team_slug}`;
      const error = options.listMemberErrors?.get(actor);
      if (error !== undefined) {
        throw error;
      }

      const members = options.teams[actor]?.members ?? [];
      const start = (page - 1) * per_page;
      const pageMembers = members.slice(start, start + per_page);

      return {
        data: pageMembers.map((login, index) => ({
          id: start + index + 101,
          login,
          type: "User",
        })),
      };
    },
  );

  return {
    rest: {
      teams: {
        getByName,
        listMembersInOrg,
      },
      users: {
        getByUsername,
      },
    },
  };
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
