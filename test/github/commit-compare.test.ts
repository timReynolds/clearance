import { describe, expect, it, vi } from "vitest";

import {
  listChangedFilesBetweenCommits,
  listFileChangesBetweenCommits,
  type CommitCompareOctokit,
} from "../../src/github/index.js";

type CompareCommits = CommitCompareOctokit["rest"]["repos"]["compareCommitsWithBasehead"];

describe("listChangedFilesBetweenCommits", () => {
  it("returns sorted filenames from GitHub compare", async () => {
    const compareCommitsWithBasehead = vi.fn<CompareCommits>(async () => ({
      data: {
        files: [{ filename: "src/z.ts" }, { filename: "src/a.ts" }],
      },
    }));
    const octokit: CommitCompareOctokit = {
      rest: {
        repos: {
          compareCommitsWithBasehead,
        },
      },
    };

    await expect(
      listChangedFilesBetweenCommits(octokit, {
        base: "before-sha",
        head: "after-sha",
        owner: "acme",
        repo: "clearance",
      }),
    ).resolves.toEqual(["src/a.ts", "src/z.ts"]);
    expect(compareCommitsWithBasehead).toHaveBeenCalledWith({
      basehead: "before-sha...after-sha",
      owner: "acme",
      repo: "clearance",
    });
  });

  it("returns an empty list when compare response omits files", async () => {
    const octokit: CommitCompareOctokit = {
      rest: {
        repos: {
          compareCommitsWithBasehead: vi.fn<CompareCommits>(async () => ({
            data: {},
          })),
        },
      },
    };

    await expect(
      listChangedFilesBetweenCommits(octokit, {
        base: "before-sha",
        head: "after-sha",
        owner: "acme",
        repo: "clearance",
      }),
    ).resolves.toEqual([]);
  });

  it("returns sorted file metadata from GitHub compare", async () => {
    const octokit: CommitCompareOctokit = {
      rest: {
        repos: {
          compareCommitsWithBasehead: vi.fn<CompareCommits>(async () => ({
            data: {
              files: [
                {
                  additions: 1,
                  deletions: 0,
                  filename: "src/z.ts",
                  patch: "@@ -1,1 +1,1 @@\n+export const z = true;",
                  status: "added",
                },
                {
                  additions: 2,
                  deletions: 1,
                  filename: "src/a.ts",
                  previous_filename: "src/old-a.ts",
                  status: "renamed",
                },
              ],
            },
          })),
        },
      },
    };

    await expect(
      listFileChangesBetweenCommits(octokit, {
        base: "before-sha",
        head: "after-sha",
        owner: "acme",
        repo: "clearance",
      }),
    ).resolves.toEqual([
      {
        additions: 2,
        deletions: 1,
        filename: "src/a.ts",
        patch: undefined,
        previousFilename: "src/old-a.ts",
        status: "renamed",
      },
      {
        additions: 1,
        deletions: 0,
        filename: "src/z.ts",
        patch: "@@ -1,1 +1,1 @@\n+export const z = true;",
        previousFilename: undefined,
        status: "added",
      },
    ]);
  });
});
