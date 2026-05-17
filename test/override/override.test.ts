import { describe, expect, it } from "vitest";

import { evaluateOverride } from "../../src/override/index.js";
import { parseOwnersToml, type OwnershipFile } from "../../src/owners/index.js";

describe("evaluateOverride", () => {
  it("does not activate when no override is configured or the label is absent", () => {
    expect(
      evaluateOverride({
        actor: "admin",
        at: "2026-05-17T12:00:00.000Z",
        configValid: true,
        labels: ["clearance-override"],
        ownershipFiles: [ownershipFile("")],
        teamMembersByActor: {},
      }),
    ).toEqual({
      active: false,
      reason: "no override is configured",
    });

    expect(
      evaluateOverride({
        actor: "admin",
        at: "2026-05-17T12:00:00.000Z",
        configValid: true,
        labels: [],
        ownershipFiles: [overrideFile()],
        teamMembersByActor: {
          "@org/admins": ["admin"],
        },
      }),
    ).toEqual({
      active: false,
      reason: "override label clearance-override is not present",
    });
  });

  it("rejects unauthorized override actors", () => {
    expect(
      evaluateOverride({
        actor: "mallory",
        at: "2026-05-17T12:00:00.000Z",
        configValid: true,
        labels: ["clearance-override"],
        ownershipFiles: [overrideFile()],
        teamMembersByActor: {
          "@org/admins": ["admin"],
        },
      }),
    ).toEqual({
      active: false,
      reason: "actor mallory is not a member of an override team",
    });
  });

  it("activates authorized overrides and returns an audit event", () => {
    expect(
      evaluateOverride({
        actor: "admin",
        at: "2026-05-17T12:00:00.000Z",
        configValid: true,
        labels: ["bugfix", "clearance-override"],
        ownershipFiles: [overrideFile()],
        teamMembersByActor: {
          "@org/admins": ["admin"],
        },
      }),
    ).toEqual({
      active: true,
      actor: "admin",
      auditEvent: {
        actor: "admin",
        at: "2026-05-17T12:00:00.000Z",
        message: "Override activated with label clearance-override",
        type: "override",
      },
      label: "clearance-override",
      team: "@org/admins",
    });
  });

  it("does not allow override to bypass invalid config", () => {
    expect(
      evaluateOverride({
        actor: "admin",
        at: "2026-05-17T12:00:00.000Z",
        configValid: false,
        labels: ["clearance-override"],
        ownershipFiles: [overrideFile()],
        teamMembersByActor: {
          "@org/admins": ["admin"],
        },
      }),
    ).toEqual({
      active: false,
      reason: "invalid OWNERS.toml configuration cannot be bypassed by override",
    });
  });
});

function overrideFile(): OwnershipFile {
  return ownershipFile(`
[override]
teams = ["@org/admins"]
label = "clearance-override"
`);
}

function ownershipFile(source: string): OwnershipFile {
  const result = parseOwnersToml(source);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }

  return {
    config: result.config,
    diagnostics: [],
    directory: ".",
    path: "OWNERS.toml",
    sha: "sha",
  };
}
