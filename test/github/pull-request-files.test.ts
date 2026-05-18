import { describe, expect, it, vi } from "vitest";

import {
  listChangedPullRequestFiles,
  type PullRequestFilesOctokit,
} from "../../src/github/index.js";

type ListFiles = PullRequestFilesOctokit["rest"]["pulls"]["listFiles"];

describe("listChangedPullRequestFiles", () => {
  it("paginates changed pull request files", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
    }));
    const listFiles = vi.fn<ListFiles>(async ({ page }) => ({
      data: page === 1 ? firstPage : [{ filename: "src/last.ts" }],
    }));
    const octokit = createPullRequestFilesOctokit(listFiles);

    await expect(
      listChangedPullRequestFiles(octokit, {
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
      }),
    ).resolves.toEqual([...firstPage.map((file) => file.filename), "src/last.ts"]);
    expect(listFiles).toHaveBeenCalledWith({
      owner: "acme",
      page: 1,
      per_page: 100,
      pull_number: 42,
      repo: "clearance",
    });
    expect(listFiles).toHaveBeenCalledWith({
      owner: "acme",
      page: 2,
      per_page: 100,
      pull_number: 42,
      repo: "clearance",
    });
  });

  it("surfaces GitHub list-file failures to the workflow boundary", async () => {
    const listFiles = vi.fn<ListFiles>(async () => {
      throw new Error("files unavailable");
    });
    const octokit = createPullRequestFilesOctokit(listFiles);

    await expect(
      listChangedPullRequestFiles(octokit, {
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
      }),
    ).rejects.toThrow("files unavailable");
  });
});

function createPullRequestFilesOctokit(listFiles: ListFiles): PullRequestFilesOctokit {
  return {
    rest: {
      pulls: {
        listFiles,
      },
    },
  };
}
