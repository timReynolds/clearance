import { describe, expect, it, vi } from "vitest";

import { loadOwnershipTree, type OwnershipTreeOctokit } from "../../src/github/ownership-tree.js";

type TreeEntry = Awaited<
  ReturnType<OwnershipTreeOctokit["rest"]["git"]["getTree"]>
>["data"]["tree"][number];

describe("loadOwnershipTree", () => {
  it("returns a structured diagnostic when repository tree discovery fails", async () => {
    const octokit = createOctokitMock({
      getTreeError: new Error("GitHub API unavailable"),
      tree: [],
    });

    const tree = await loadOwnershipTree(octokit, {
      owner: "acme",
      ref: "head-sha",
      repo: "clearance",
    });

    expect(tree).toEqual({
      diagnostics: [
        expect.objectContaining({
          filePath: ".",
          message: "failed to discover OWNERS.toml files: GitHub API unavailable",
          schemaPath: "$",
          severity: "error",
        }),
      ],
      files: [],
      truncated: false,
    });
    expect(octokit.rest.git.getBlob).not.toHaveBeenCalled();
  });

  it("discovers and loads ownership files at a repository ref", async () => {
    const octokit = createOctokitMock({
      blobs: {
        "api-sha": `
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/api", count = 2 }]
`,
        "root-sha": `
[[notify]]
paths = ["**"]
teams = ["@org/compliance"]
`,
      },
      tree: [
        blob("services/api/OWNERS.toml", "api-sha"),
        blob("README.md", "readme-sha"),
        blob("OWNERS.toml", "root-sha"),
      ],
    });

    const tree = await loadOwnershipTree(octokit, {
      owner: "acme",
      ref: "head-sha",
      repo: "clearance",
    });

    expect(octokit.rest.git.getTree).toHaveBeenCalledWith({
      owner: "acme",
      recursive: "1",
      repo: "clearance",
      tree_sha: "head-sha",
    });
    expect(octokit.rest.git.getBlob).toHaveBeenNthCalledWith(1, {
      file_sha: "root-sha",
      owner: "acme",
      repo: "clearance",
    });
    expect(octokit.rest.git.getBlob).toHaveBeenNthCalledWith(2, {
      file_sha: "api-sha",
      owner: "acme",
      repo: "clearance",
    });
    expect(tree.diagnostics).toEqual([]);
    expect(tree.files.map((file) => file.path)).toEqual([
      "OWNERS.toml",
      "services/api/OWNERS.toml",
    ]);
    expect(tree.files.map((file) => file.directory)).toEqual([".", "services/api"]);
    expect(tree.files[0]?.config?.notify[0]?.teams).toEqual(["@org/compliance"]);
    expect(tree.files[1]?.config?.rule[0]?.require).toEqual([{ count: 2, from: "@org/api" }]);
  });

  it("returns deterministic files and flattened diagnostics", async () => {
    const octokit = createOctokitMock({
      blobs: {
        "docs-sha": `
[[rule]]
paths = ["docs/**"]
require = [{ from = "@org/docs", count = 0 }]
`,
        "root-sha": "",
      },
      tree: [blob("docs/OWNERS.toml", "docs-sha"), blob("OWNERS.toml", "root-sha")],
      truncated: true,
    });

    const tree = await loadOwnershipTree(octokit, {
      owner: "acme",
      ref: "head-sha",
      repo: "clearance",
    });

    expect(tree.truncated).toBe(true);
    expect(tree.files.map((file) => file.path)).toEqual(["OWNERS.toml", "docs/OWNERS.toml"]);
    expect(tree.files[0]?.config).toEqual({
      inherit: true,
      notify: [],
      rule: [],
    });
    expect(tree.files[1]?.config).toBeUndefined();
    expect(tree.files[1]?.diagnostics[0]).toEqual(
      expect.objectContaining({
        filePath: "docs/OWNERS.toml",
        schemaPath: "$.rule[0].require[0].count",
        severity: "error",
      }),
    );
    expect(tree.diagnostics).toEqual([
      expect.objectContaining({
        filePath: ".",
        message: "repository tree was truncated; OWNERS.toml discovery may be incomplete",
        severity: "warning",
      }),
      expect.objectContaining({
        filePath: "docs/OWNERS.toml",
        schemaPath: "$.rule[0].require[0].count",
      }),
    ]);
  });

  it("propagates blob loading errors as file diagnostics", async () => {
    const octokit = createOctokitMock({
      blobResponses: {
        "bad-encoding-sha": {
          content: encode("inherit = true"),
          encoding: "utf-8",
        },
        "missing-content-sha": {
          encoding: "base64",
        },
        "not-base64-sha": {
          content: "not-base64!",
          encoding: "base64",
        },
      },
      tree: [
        blob("bad-encoding/OWNERS.toml", "bad-encoding-sha"),
        blob("missing-content/OWNERS.toml", "missing-content-sha"),
        blob("not-base64/OWNERS.toml", "not-base64-sha"),
      ],
    });

    const tree = await loadOwnershipTree(octokit, {
      owner: "acme",
      ref: "head-sha",
      repo: "clearance",
    });

    expect(tree.files).toEqual([
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            filePath: "bad-encoding/OWNERS.toml",
            message: "expected base64 blob encoding, received utf-8",
          }),
        ],
        path: "bad-encoding/OWNERS.toml",
      }),
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            filePath: "missing-content/OWNERS.toml",
            message: "blob response did not include content",
          }),
        ],
        path: "missing-content/OWNERS.toml",
      }),
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            filePath: "not-base64/OWNERS.toml",
            message: "blob content is not valid base64",
          }),
        ],
        path: "not-base64/OWNERS.toml",
      }),
    ]);
    expect(tree.files[0]?.config).toBeUndefined();
    expect(tree.files[1]?.config).toBeUndefined();
    expect(tree.files[2]?.config).toBeUndefined();
  });

  it("rejects unsafe ownership file locations before blob loading", async () => {
    const octokit = createOctokitMock({
      blobs: {
        "safe-sha": "",
      },
      tree: [
        blob("services/../OWNERS.toml", "traversal-sha"),
        { ...blob("linked/OWNERS.toml", "symlink-sha"), mode: "120000" },
        blob("safe/OWNERS.toml", "safe-sha"),
      ],
    });

    const tree = await loadOwnershipTree(octokit, {
      owner: "acme",
      ref: "head-sha",
      repo: "clearance",
    });

    expect(octokit.rest.git.getBlob).toHaveBeenCalledTimes(1);
    expect(octokit.rest.git.getBlob).toHaveBeenCalledWith({
      file_sha: "safe-sha",
      owner: "acme",
      repo: "clearance",
    });
    expect(tree.files).toEqual([
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            message: "symlinked OWNERS.toml files are not supported",
          }),
        ],
        path: "linked/OWNERS.toml",
      }),
      expect.objectContaining({
        diagnostics: [],
        path: "safe/OWNERS.toml",
      }),
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            message: "OWNERS.toml path contains traversal segments",
          }),
        ],
        path: "services/../OWNERS.toml",
      }),
    ]);
  });

  it("rejects unusable tree entries before blob loading", async () => {
    const octokit = createOctokitMock({
      blobs: {
        "safe-sha": "",
      },
      tree: [
        blob("safe/OWNERS.toml", "safe-sha"),
        { ...blob("tree/OWNERS.toml", "tree-sha"), type: "tree" },
        { mode: "100644", path: "missing-sha/OWNERS.toml", type: "blob" },
      ],
    });

    const tree = await loadOwnershipTree(octokit, {
      owner: "acme",
      ref: "head-sha",
      repo: "clearance",
    });

    expect(octokit.rest.git.getBlob).toHaveBeenCalledTimes(1);
    expect(tree.files).toEqual([
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            message: "OWNERS.toml entry is missing a blob sha",
          }),
        ],
        path: "missing-sha/OWNERS.toml",
      }),
      expect.objectContaining({
        diagnostics: [],
        path: "safe/OWNERS.toml",
      }),
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            message: "OWNERS.toml entry is not a blob",
          }),
        ],
        path: "tree/OWNERS.toml",
      }),
    ]);
  });

  it("detects duplicate ownership locations after canonical path normalization", async () => {
    const octokit = createOctokitMock({
      blobs: {
        "canonical-sha": "",
      },
      tree: [
        blob("services/OWNERS.toml", "canonical-sha"),
        blob("services/./OWNERS.toml", "duplicate-sha"),
      ],
    });

    const tree = await loadOwnershipTree(octokit, {
      owner: "acme",
      ref: "head-sha",
      repo: "clearance",
    });

    expect(octokit.rest.git.getBlob).toHaveBeenCalledTimes(1);
    expect(tree.files).toEqual([
      expect.objectContaining({
        diagnostics: [],
        path: "services/OWNERS.toml",
      }),
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            message:
              "OWNERS.toml path must be canonical; normalized path would be services/OWNERS.toml",
          }),
          expect.objectContaining({
            message:
              "duplicate ownership location for services; already discovered services/OWNERS.toml",
          }),
        ],
        path: "services/OWNERS.toml",
      }),
    ]);
  });
});

function blob(path: string, sha: string): TreeEntry {
  return {
    mode: "100644",
    path,
    sha,
    type: "blob",
  };
}

function createOctokitMock(options: {
  blobResponses?: Record<string, { content?: string; encoding?: string }>;
  blobs?: Record<string, string>;
  getTreeError?: Error;
  tree: TreeEntry[];
  truncated?: boolean;
}): OwnershipTreeOctokit {
  const blobResponses = options.blobResponses ?? {};
  const blobs = options.blobs ?? {};
  const getBlob = vi.fn<OwnershipTreeOctokit["rest"]["git"]["getBlob"]>(async ({ file_sha }) => {
    const blobResponse = blobResponses[file_sha];
    if (blobResponse !== undefined) {
      return {
        data: blobResponse,
      };
    }

    const source = blobs[file_sha];
    if (source === undefined) {
      throw new Error(`missing mock blob ${file_sha}`);
    }

    return {
      data: {
        content: encode(source),
        encoding: "base64",
      },
    };
  });
  const getTree = vi.fn<OwnershipTreeOctokit["rest"]["git"]["getTree"]>(async () => {
    if (options.getTreeError !== undefined) {
      throw options.getTreeError;
    }

    return {
      data: {
        tree: options.tree,
        truncated: options.truncated,
      },
    };
  });

  return {
    rest: {
      git: {
        getBlob,
        getTree,
      },
    },
  };
}

function encode(source: string): string {
  return Buffer.from(source, "utf8").toString("base64");
}
