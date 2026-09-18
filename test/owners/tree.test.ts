import { describe, expect, it } from "vitest";

import {
  buildOwnershipTree,
  discoverOwnershipFiles,
  isLoadableOwnershipFile,
} from "../../src/owners/index.js";

describe("ownership tree core", () => {
  it("discovers ownership files and parses supplied file contents without a GitHub client", () => {
    const discovery = discoverOwnershipFiles([
      {
        mode: "100644",
        path: "services/api/OWNERS.toml",
        sha: "api-sha",
        type: "blob",
      },
      {
        mode: "100644",
        path: "README.md",
        sha: "readme-sha",
        type: "blob",
      },
      {
        mode: "100644",
        path: "OWNERS.toml",
        sha: "root-sha",
        type: "blob",
      },
    ]);

    expect(discovery.files.filter((file) => isLoadableOwnershipFile(file))).toEqual([
      expect.objectContaining({
        path: "OWNERS.toml",
        sha: "root-sha",
      }),
      expect.objectContaining({
        path: "services/api/OWNERS.toml",
        sha: "api-sha",
      }),
    ]);

    const tree = buildOwnershipTree(discovery, [
      {
        path: "OWNERS.toml",
        source: `
[[notify]]
paths = ["**"]
teams = ["@org/compliance"]
`,
      },
      {
        path: "services/api/OWNERS.toml",
        source: `
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/api", count = 2 }]
`,
      },
    ]);

    expect(tree.diagnostics).toEqual([]);
    expect(tree.files.map((file) => file.path)).toEqual([
      "OWNERS.toml",
      "services/api/OWNERS.toml",
    ]);
    expect(tree.files[0]?.config?.notify[0]?.teams).toEqual(["@org/compliance"]);
    expect(tree.files[1]?.config?.rule[0]?.require).toEqual([{ count: 2, from: "@org/api" }]);
  });

  it("keeps discovery diagnostics separate from backend content loading errors", () => {
    const discovery = discoverOwnershipFiles(
      [
        {
          mode: "100644",
          path: "docs/OWNERS.toml",
          sha: "docs-sha",
          type: "blob",
        },
        {
          mode: "100644",
          path: "services/./OWNERS.toml",
          sha: "duplicate-sha",
          type: "blob",
        },
        {
          mode: "100644",
          path: "services/OWNERS.toml",
          sha: "services-sha",
          type: "blob",
        },
      ],
      { truncated: true },
    );

    const tree = buildOwnershipTree(discovery, [
      {
        error: "backend read failed",
        path: "docs/OWNERS.toml",
      },
      {
        path: "services/OWNERS.toml",
        source: "",
      },
    ]);

    expect(tree.truncated).toBe(true);
    expect(tree.diagnostics).toEqual([
      expect.objectContaining({
        filePath: ".",
        message: "repository tree was truncated; OWNERS.toml discovery may be incomplete",
        severity: "warning",
      }),
      expect.objectContaining({
        filePath: "docs/OWNERS.toml",
        message: "backend read failed",
      }),
      expect.objectContaining({
        filePath: "services/./OWNERS.toml",
        message:
          "OWNERS.toml path must be canonical; normalized path would be services/OWNERS.toml",
      }),
      expect.objectContaining({
        filePath: "services/./OWNERS.toml",
        message:
          "duplicate ownership location for services; already discovered services/OWNERS.toml",
      }),
    ]);
  });
});
