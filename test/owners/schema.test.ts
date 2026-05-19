import { describe, expect, it } from "vitest";

import { parseOwnersToml } from "../../src/owners/index.js";

describe("parseOwnersToml", () => {
  it("parses the core OWNERS.toml structure", () => {
    const result = parseOwnersToml(
      `
inherit = true

[escalation]
warn_after = "4h"
escalate_after = "8h"
fallback_after = "24h"
fallback_team = "@org/platform-leads"
reset_on_push = true

[[rule]]
paths = ["**"]
require = [
  { from = "@org/platform-eng", count = 1 },
]
require_any = [
  { from = "@org/security-eng", count = 1 },
  { from = "@org/compliance", count = 1 },
]

[[notify]]
paths = ["**"]
teams = ["@org/compliance"]

[override]
teams = ["@org/repo-admins"]
`,
      { filePath: "services/api/OWNERS.toml" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join("\n"));
    }

    expect(result.diagnostics).toEqual([]);
    expect(result.config.inherit).toBe(true);
    expect(result.config.rule).toHaveLength(1);
    expect(result.config.rule[0]?.require).toEqual([{ from: "@org/platform-eng", count: 1 }]);
    expect(result.config.rule[0]?.require_any).toEqual([
      [
        { from: "@org/security-eng", count: 1 },
        { from: "@org/compliance", count: 1 },
      ],
    ]);
    expect(result.config.notify[0]?.teams).toEqual(["@org/compliance"]);
  });

  it("defaults inheritance to true", () => {
    const result = expectParseSuccess(`
[[rule]]
paths = ["**"]
require = [{ from = "@org/platform-eng", count = 1 }]
`);

    expect(result.config.inherit).toBe(true);
  });

  it("defaults optional arrays and approval counts", () => {
    const result = expectParseSuccess(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform-eng" }]

[[notify]]
paths = ["docs/**"]
`);

    expect(result.config.rule[0]?.require).toEqual([{ from: "@org/platform-eng", count: 1 }]);
    expect(result.config.rule[0]?.require_any).toEqual([]);
    expect(result.config.notify[0]?.teams).toEqual([]);
    expect(result.config.notify[0]?.users).toEqual([]);
  });

  it("supports multiple independent require_any groups in one rule", () => {
    const result = expectParseSuccess(`
[[rule]]
paths = ["**"]
require_any = [
  [
    { from = "@org/security-eng", count = 1 },
    { from = "@org/compliance", count = 1 },
  ],
  [
    { from = "@org/platform", count = 1 },
    { from = "@org/ml-platform", count = 1 },
  ],
]
`);

    expect(result.config.rule[0]?.require_any).toEqual([
      [
        { from: "@org/security-eng", count: 1 },
        { from: "@org/compliance", count: 1 },
      ],
      [
        { from: "@org/platform", count: 1 },
        { from: "@org/ml-platform", count: 1 },
      ],
    ]);
  });

  it("parses an empty file with root defaults", () => {
    const result = expectParseSuccess("");

    expect(result.config).toEqual({
      inherit: true,
      notify: [],
      rule: [],
    });
  });

  it("allows inheritance to be disabled", () => {
    const result = expectParseSuccess(`
inherit = false
`);

    expect(result.config.inherit).toBe(false);
  });

  it("rejects unknown keys with structured diagnostics", () => {
    const result = expectParseFailure(`
unknown = true
`);

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        filePath: "OWNERS.toml",
        line: 2,
        lineText: "unknown = true",
        message: 'unrecognized key "unknown"',
        schemaPath: "$.unknown",
        severity: "error",
      }),
    ]);
    expect(result.errors.join("\n")).toContain("OWNERS.toml:2 $.unknown");
  });

  it("rejects nested unknown keys with specific schema paths", () => {
    const result = expectParseFailure(`
[escalation]
warn_after = "4h"
timezone = "UTC"

[[rule]]
paths = ["**"]
extra = true
require = [{ from = "@org/platform-eng", count = 1, reason = "database" }]
`);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          line: 4,
          lineText: 'timezone = "UTC"',
          message: 'unrecognized key "timezone"',
          schemaPath: "$.escalation.timezone",
        }),
        expect.objectContaining({
          line: 8,
          lineText: "extra = true",
          message: 'unrecognized key "extra"',
          schemaPath: "$.rule[0].extra",
        }),
        expect.objectContaining({
          line: 9,
          lineText: 'require = [{ from = "@org/platform-eng", count = 1, reason = "database" }]',
          message: 'unrecognized key "reason"',
          schemaPath: "$.rule[0].require[0].reason",
        }),
      ]),
    );
  });

  it("reports malformed TOML with line context", () => {
    const result = expectParseFailure(`
[[rule]
paths = ["**"]
`);

    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        column: 8,
        line: 2,
        lineText: "[[rule]",
        schemaPath: "$",
        severity: "error",
      }),
    );
    expect(result.diagnostics[0]?.message).toContain('Expected "]"');
  });

  it("uses the provided file path in formatted errors", () => {
    const result = parseOwnersToml(
      `
unknown = true
`,
      { filePath: "services/api/OWNERS.toml" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected parse to fail");
    }

    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        filePath: "services/api/OWNERS.toml",
        schemaPath: "$.unknown",
      }),
    );
    expect(result.errors[0]).toContain("services/api/OWNERS.toml:2 $.unknown");
  });

  it("rejects malformed actor references", () => {
    const result = expectParseFailure(`
[[notify]]
paths = ["**"]
teams = ["@alice"]
users = ["@org/team"]
`);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          line: 4,
          schemaPath: "$.notify[0].teams[0]",
        }),
        expect.objectContaining({
          line: 5,
          schemaPath: "$.notify[0].users[0]",
        }),
      ]),
    );
  });

  it("rejects users in team-only fields", () => {
    const result = expectParseFailure(`
[escalation]
fallback_team = "@alice"

[override]
teams = ["@alice"]
`);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          line: 3,
          schemaPath: "$.escalation.fallback_team",
        }),
        expect.objectContaining({
          line: 6,
          schemaPath: "$.override.teams[0]",
        }),
      ]),
    );
  });

  it("rejects bad durations", () => {
    const result = expectParseFailure(`
[escalation]
warn_after = "0m"
fallback_team = "@org/platform-leads"
`);

    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        line: 3,
        lineText: 'warn_after = "0m"',
        schemaPath: "$.escalation.warn_after",
      }),
    );
  });

  it("rejects unsupported duration units", () => {
    const result = expectParseFailure(`
[escalation]
escalate_after = "2mo"
`);

    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        line: 3,
        lineText: 'escalate_after = "2mo"',
        schemaPath: "$.escalation.escalate_after",
      }),
    );
  });

  it("rejects missing paths", () => {
    const result = expectParseFailure(`
[[rule]]
require = [{ from = "@org/platform-eng", count = 1 }]
`);

    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        line: 2,
        lineText: "[[rule]]",
        schemaPath: "$.rule[0].paths",
      }),
    );
  });

  it("rejects empty path arrays and empty path entries", () => {
    const result = expectParseFailure(`
[[rule]]
paths = []

[[notify]]
paths = [""]
`);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          line: 3,
          schemaPath: "$.rule[0].paths",
        }),
        expect.objectContaining({
          line: 6,
          schemaPath: "$.notify[0].paths[0]",
        }),
      ]),
    );
  });

  it("rejects bad approval counts", () => {
    const result = expectParseFailure(`
[[rule]]
paths = ["**"]
require = [{ from = "@org/platform-eng", count = 0 }]
`);

    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        line: 4,
        lineText: 'require = [{ from = "@org/platform-eng", count = 0 }]',
        schemaPath: "$.rule[0].require[0].count",
      }),
    );
  });

  it("rejects fractional approval counts", () => {
    const result = expectParseFailure(`
[[rule]]
paths = ["**"]
require_any = [{ from = "@org/security", count = 1.5 }]
`);

    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        line: 4,
        lineText: 'require_any = [{ from = "@org/security", count = 1.5 }]',
        schemaPath: "$.rule[0].require_any[0].count",
      }),
    );
  });

  it("rejects type mismatches with field-specific paths", () => {
    const result = expectParseFailure(`
inherit = "true"

[[rule]]
paths = "**"
require = [{ from = "@org/platform-eng", count = "1" }]
`);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          line: 2,
          schemaPath: "$.inherit",
        }),
        expect.objectContaining({
          line: 5,
          schemaPath: "$.rule[0].paths",
        }),
        expect.objectContaining({
          line: 6,
          schemaPath: "$.rule[0].require[0].count",
        }),
      ]),
    );
  });

  it("reports diagnostics against the matching repeated table", () => {
    const result = expectParseFailure(`
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/app", count = 1 }]

[[rule]]
paths = ["docs/**"]
require = [{ from = "@org/docs", count = 0 }]
`);

    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        line: 8,
        lineText: 'require = [{ from = "@org/docs", count = 0 }]',
        schemaPath: "$.rule[1].require[0].count",
      }),
    );
  });

  it("returns multiple diagnostics in deterministic schema order", () => {
    const result = expectParseFailure(`
inherit = "yes"

[[rule]]
paths = []
require = [{ from = "org/platform-eng", count = 0 }]

[override]
teams = []
`);

    expect(result.diagnostics.map((diagnostic) => diagnostic.schemaPath)).toEqual([
      "$.inherit",
      "$.rule[0].paths",
      "$.rule[0].require[0].from",
      "$.rule[0].require[0].count",
      "$.override.teams",
    ]);
  });
});

function expectParseSuccess(source: string) {
  const result = parseOwnersToml(source);

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }

  return result;
}

function expectParseFailure(source: string) {
  const result = parseOwnersToml(source);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected parse to fail");
  }

  return result;
}
