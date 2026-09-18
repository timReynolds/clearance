import { describe, expect, it, vi } from "vitest";

import { listOpenPullRequests, type OpenPullRequestsOctokit } from "../../src/github/index.js";

type ListPulls = OpenPullRequestsOctokit["rest"]["pulls"]["list"];

describe("listOpenPullRequests", () => {
  it("paginates open pull requests and normalizes labels", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      head: {
        sha: `head-${index}`,
      },
      labels: [{ name: "ready" }],
      number: index + 1,
      user: {
        login: "author",
      },
    }));
    const list = vi.fn<ListPulls>(async ({ page }) => ({
      data:
        page === 1
          ? firstPage
          : [
              {
                head: {
                  sha: "head-last",
                },
                labels: ["bug", { name: "urgent" }, {}],
                number: 101,
                user: {
                  login: "maintainer",
                },
              },
              {
                head: {
                  sha: "head-missing-author",
                },
                number: 102,
              },
            ],
    }));

    const result = await listOpenPullRequests(
      {
        rest: {
          pulls: {
            list,
          },
        },
      },
      {
        owner: "acme",
        repo: "clearance",
      },
    );

    expect(result).toHaveLength(101);
    expect(result.at(-1)).toEqual({
      author: "maintainer",
      headSha: "head-last",
      labels: ["bug", "urgent"],
      number: 101,
    });
    expect(list).toHaveBeenCalledWith({
      owner: "acme",
      page: 1,
      per_page: 100,
      repo: "clearance",
      state: "open",
    });
    expect(list).toHaveBeenCalledWith({
      owner: "acme",
      page: 2,
      per_page: 100,
      repo: "clearance",
      state: "open",
    });
  });
});
