import { describe, expect, it } from "vitest";

import { parseOwnersToml, type OwnersConfig } from "../../src/owners/index.js";
import { resolveOwnership, type LoadedOwnershipFile } from "../../src/resolution/index.js";

describe("resolveOwnership", () => {
  it("resolves child ownership before inherited parent ownership", () => {
    const result = resolveOwnership({
      changedFiles: ["services/api/src/routes.ts"],
      ownershipFiles: [
        ownersFile(
          ".",
          `
[[rule]]
paths = ["services/**"]
require = [{ from = "@org/root", count = 1 }]
`,
        ),
        ownersFile(
          "services/api",
          `
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/api", count = 2 }]
`,
        ),
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.andRequirements.map((requirement) => requirement.from)).toEqual([
      "@org/api",
      "@org/root",
    ]);
    expect(result.andRequirements[0]).toEqual(
      expect.objectContaining({
        count: 2,
        identity: "and:services/api:@org/api:2",
        triggers: [
          expect.objectContaining({
            changedFile: "services/api/src/routes.ts",
            matchedPath: "src/routes.ts",
            ownersDirectory: "services/api",
            ownersPath: "services/api/OWNERS.toml",
            pattern: "src/**",
            ruleIndex: 0,
          }),
        ],
      }),
    );
    expect(result.andRequirements[1]?.triggers[0]).toEqual(
      expect.objectContaining({
        matchedPath: "services/api/src/routes.ts",
        ownersDirectory: ".",
        pattern: "services/**",
      }),
    );
  });

  it("stops collecting parent rules when a child ownership file disables inheritance", () => {
    const result = resolveOwnership({
      changedFiles: ["services/api/src/routes.ts"],
      ownershipFiles: [
        ownersFile(
          ".",
          `
[[rule]]
paths = ["**"]
require = [{ from = "@org/root", count = 1 }]
`,
        ),
        ownersFile(
          "services",
          `
inherit = false

[[rule]]
paths = ["api/**"]
require = [{ from = "@org/services", count = 1 }]
`,
        ),
      ],
    });

    expect(result.andRequirements.map((requirement) => requirement.from)).toEqual([
      "@org/services",
    ]);
  });

  it("returns OR requirements and notifications for matching relative globs", () => {
    const result = resolveOwnership({
      changedFiles: ["apps/web/src/pages/home.ts"],
      ownershipFiles: [
        ownersFile(
          "apps/web",
          `
[[rule]]
paths = ["src/**/*.ts"]
require_any = [
  { from = "@org/security", count = 1 },
  { from = "@org/compliance", count = 2 },
]

[[notify]]
paths = ["src/**", "README.md"]
teams = ["@org/docs"]
users = ["@alice"]
`,
        ),
      ],
    });

    expect(result.andRequirements).toEqual([]);
    expect(result.orRequirements).toEqual([
      expect.objectContaining({
        identity: "or:apps/web:@org/compliance:2|@org/security:1",
        options: [
          { count: 1, from: "@org/security" },
          { count: 2, from: "@org/compliance" },
        ],
        triggers: [
          expect.objectContaining({
            changedFile: "apps/web/src/pages/home.ts",
            matchedPath: "src/pages/home.ts",
            pattern: "src/**/*.ts",
          }),
        ],
        type: "or",
      }),
    ]);
    expect(result.notifications).toEqual([
      expect.objectContaining({
        identity: "notify:apps/web:teams=@org/docs:users=@alice",
        teams: ["@org/docs"],
        triggers: [
          expect.objectContaining({
            matchedPath: "src/pages/home.ts",
            notifyIndex: 0,
            pattern: "src/**",
          }),
        ],
        users: ["@alice"],
      }),
    ]);
  });

  it("resolves multiple require_any groups in one matching rule as independent OR requirements", () => {
    const result = resolveOwnership({
      changedFiles: ["src/index.ts"],
      ownershipFiles: [
        ownersFile(
          ".",
          `
[[rule]]
paths = ["src/**"]
require_any = [
  [
    { from = "@org/security", count = 1 },
    { from = "@org/compliance", count = 1 },
  ],
  [
    { from = "@org/platform", count = 1 },
    { from = "@org/ml-platform", count = 1 },
  ],
]
`,
        ),
      ],
    });

    expect(result.orRequirements.map((requirement) => requirement.identity)).toEqual([
      "or:.:@org/compliance:1|@org/security:1",
      "or:.:@org/ml-platform:1|@org/platform:1",
    ]);
    expect(result.orRequirements).toEqual([
      expect.objectContaining({
        options: [
          { count: 1, from: "@org/security" },
          { count: 1, from: "@org/compliance" },
        ],
      }),
      expect.objectContaining({
        options: [
          { count: 1, from: "@org/platform" },
          { count: 1, from: "@org/ml-platform" },
        ],
      }),
    ]);
  });

  it("deduplicates identical requirements across files and matching rules", () => {
    const result = resolveOwnership({
      changedFiles: ["src/index.ts", "src/lib/util.ts"],
      ownershipFiles: [
        ownersFile(
          ".",
          `
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]

[[rule]]
paths = ["src/**/*.ts"]
require = [{ from = "@org/platform", count = 1 }]
`,
        ),
      ],
    });

    expect(result.andRequirements).toHaveLength(1);
    expect(result.andRequirements[0]).toEqual(
      expect.objectContaining({
        identity: "and:.:@org/platform:1",
        triggers: [
          expect.objectContaining({
            changedFile: "src/index.ts",
            pattern: "src/**",
            ruleIndex: 0,
          }),
          expect.objectContaining({
            changedFile: "src/index.ts",
            pattern: "src/**/*.ts",
            ruleIndex: 1,
          }),
          expect.objectContaining({
            changedFile: "src/lib/util.ts",
            pattern: "src/**",
            ruleIndex: 0,
          }),
          expect.objectContaining({
            changedFile: "src/lib/util.ts",
            pattern: "src/**/*.ts",
            ruleIndex: 1,
          }),
        ],
      }),
    );
  });

  it("deduplicates OR requirements with the same options regardless of option order", () => {
    const result = resolveOwnership({
      changedFiles: ["src/index.ts"],
      ownershipFiles: [
        ownersFile(
          ".",
          `
[[rule]]
paths = ["src/**"]
require_any = [
  { from = "@org/security", count = 1 },
  { from = "@org/compliance", count = 1 },
]

[[rule]]
paths = ["src/**/*.ts"]
require_any = [
  { from = "@org/compliance", count = 1 },
  { from = "@org/security", count = 1 },
]
`,
        ),
      ],
    });

    expect(result.orRequirements).toHaveLength(1);
    expect(result.orRequirements[0]?.options).toEqual([
      { count: 1, from: "@org/security" },
      { count: 1, from: "@org/compliance" },
    ]);
    expect(result.orRequirements[0]?.triggers.map((trigger) => trigger.ruleIndex)).toEqual([0, 1]);
  });

  it("reports invalid changed paths and continues resolving valid files", () => {
    const result = resolveOwnership({
      changedFiles: ["../secret.ts", "src/index.ts"],
      ownershipFiles: [
        ownersFile(
          ".",
          `
[[rule]]
paths = ["**"]
require = [{ from = "@org/platform", count = 1 }]
`,
        ),
      ],
    });

    expect(result.diagnostics).toEqual([
      {
        filePath: "../secret.ts",
        message: "changed file path must be a relative repository file path",
        severity: "error",
      },
    ]);
    expect(result.andRequirements.map((requirement) => requirement.from)).toEqual([
      "@org/platform",
    ]);
  });
});

function ownersFile(directory: string, source: string): LoadedOwnershipFile {
  return {
    config: parseConfig(source),
    directory,
    path: directory === "." ? "OWNERS.toml" : `${directory}/OWNERS.toml`,
  };
}

function parseConfig(source: string): OwnersConfig {
  const result = parseOwnersToml(source);

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }

  return result.config;
}
