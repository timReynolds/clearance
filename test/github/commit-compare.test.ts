import { describe, expect, it, vi } from "vitest";

import {
  listChangedFilesBetweenCommits,
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
});
