import { describe, expect, it } from "vitest";

import { evaluateOverride, parseOverrideCommentCommand } from "../../src/override/index.js";
import { parseOwnersToml, type OwnershipFile } from "../../src/owners/index.js";

describe("override commands", () => {
  it("parses activation and revoke comment commands", () => {
    expect(parseOverrideCommentCommand("@clearance override")).toEqual({ type: "activate" });
    expect(parseOverrideCommentCommand("@clearance override revoke")).toEqual({ type: "revoke" });
    expect(parseOverrideCommentCommand("looks good")).toBeUndefined();
  });

  it("does not activate when no override is configured", () => {
    expect(
      evaluateOverride({
        actor: "admin",
        at: "2026-05-17T12:00:00.000Z",
        command: { type: "activate" },
        configValid: true,
        ownershipFiles: [ownershipFile("")],
        teamMembersByActor: {},
      }),
    ).toEqual({
      reason: "no override is configured",
      type: "rejected",
    });
  });

  it("rejects unauthorized override actors", () => {
    expect(
      evaluateOverride({
        actor: "mallory",
        at: "2026-05-17T12:00:00.000Z",
        command: { commentId: 123, type: "activate" },
        configValid: true,
        ownershipFiles: [overrideFile()],
        teamMembersByActor: {
          "@org/admins": ["admin"],
        },
      }),
    ).toEqual({
      reason: "actor mallory is not a member of an override team",
      type: "rejected",
    });
  });

  it("authorizes activate and revoke commands from override team members", () => {
    const input = {
      actor: "admin",
      at: "2026-05-17T12:00:00.000Z",
      configValid: true,
      ownershipFiles: [overrideFile()],
      teamMembersByActor: {
        "@org/admins": ["admin"],
      },
    };

    expect(
      evaluateOverride({
        ...input,
        command: { commentId: 123, type: "activate" },
      }),
    ).toEqual({
      actor: "admin",
      auditEvent: {
        actor: "admin",
        at: "2026-05-17T12:00:00.000Z",
        message: "Override activated by @clearance override command",
        type: "override",
      },
      commentId: 123,
      team: "@org/admins",
      type: "activate",
    });
    expect(
      evaluateOverride({
        ...input,
        command: { commentId: 124, type: "revoke" },
      }),
    ).toEqual({
      actor: "admin",
      auditEvent: {
        actor: "admin",
        at: "2026-05-17T12:00:00.000Z",
        message: "Override revoked by @clearance override command",
        type: "override",
      },
      commentId: 124,
      team: "@org/admins",
      type: "revoke",
    });
  });

  it("does not allow override to bypass invalid config", () => {
    expect(
      evaluateOverride({
        actor: "admin",
        at: "2026-05-17T12:00:00.000Z",
        command: { type: "activate" },
        configValid: false,
        ownershipFiles: [overrideFile()],
        teamMembersByActor: {
          "@org/admins": ["admin"],
        },
      }),
    ).toEqual({
      reason: "invalid OWNERS.toml configuration cannot be bypassed by override",
      type: "rejected",
    });
  });
});

function overrideFile(): OwnershipFile {
  return ownershipFile(`
[override]
teams = ["@org/admins"]
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
