import { Buffer } from "node:buffer";

import { Webhooks, type EmitterWebhookEvent } from "@octokit/webhooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerGithubHandlers,
  type GithubInstallationClientFactory,
  type GithubWorkflowOctokit,
} from "../../src/github/handlers.js";

type GetBlob = GithubWorkflowOctokit["rest"]["git"]["getBlob"];
type GetTree = GithubWorkflowOctokit["rest"]["git"]["getTree"];
type GetTeam = GithubWorkflowOctokit["rest"]["teams"]["getByName"];
type ListMembers = GithubWorkflowOctokit["rest"]["teams"]["listMembersInOrg"];
type ListFiles = GithubWorkflowOctokit["rest"]["pulls"]["listFiles"];
type ListComments = GithubWorkflowOctokit["rest"]["issues"]["listComments"];
type CreateComment = GithubWorkflowOctokit["rest"]["issues"]["createComment"];
type CreateCommitStatus = GithubWorkflowOctokit["rest"]["repos"]["createCommitStatus"];
type RequestReviewers = GithubWorkflowOctokit["rest"]["pulls"]["requestReviewers"];
type CompareCommits = GithubWorkflowOctokit["rest"]["repos"]["compareCommitsWithBasehead"];
type GetUser = GithubWorkflowOctokit["rest"]["users"]["getByUsername"];
type UpdateComment = GithubWorkflowOctokit["rest"]["issues"]["updateComment"];

describe("registerGithubHandlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("processes a signed pull_request webhook through Octokit Webhooks", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const webhooks = new Webhooks({ secret: "test-secret" });
    const octokit = createWorkflowOctokit();

    registerGithubHandlers(webhooks, {
      getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
        async () => octokit,
      ),
    });

    const payload = createPullRequestPayload("opened");
    const serializedPayload = JSON.stringify(payload);
    const signature = await webhooks.sign(serializedPayload);

    await webhooks.verifyAndReceive({
      id: "delivery-id",
      name: "pull_request",
      payload: serializedPayload,
      signature,
    });

    expect(octokit.rest.git.getTree).toHaveBeenCalledWith({
      owner: "acme",
      recursive: "1",
      repo: "clearance",
      tree_sha: "head-sha",
    });
    expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith({
      owner: "acme",
      pull_number: 42,
      repo: "clearance",
      reviewers: ["alice"],
    });
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("<!-- clearance-state:v1"),
        issue_number: 42,
      }),
    );
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "clearance/config",
        state: "success",
      }),
    );
  });

  it("uses GitHub compare data for synchronize scoped invalidation", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const webhooks = new Webhooks({ secret: "test-secret" });
    const octokit = createWorkflowOctokit();

    registerGithubHandlers(webhooks, {
      getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
        async () => octokit,
      ),
    });

    await webhooks.receive({
      id: "delivery-id",
      name: "pull_request",
      payload: createPullRequestPayload("synchronize"),
    } as unknown as EmitterWebhookEvent);

    expect(octokit.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith({
      basehead: "before-sha...head-sha",
      owner: "acme",
      repo: "clearance",
    });
  });
});

function createWorkflowOctokit(): GithubWorkflowOctokit {
  return {
    rest: {
      git: {
        getBlob: vi.fn<GetBlob>(async () => ({
          data: {
            content: Buffer.from(
              `
[[rule]]
paths = ["src/**"]
require = [{ from = "@org/platform", count = 1 }]
`,
              "utf8",
            ).toString("base64"),
            encoding: "base64",
          },
        })),
        getTree: vi.fn<GetTree>(async () => ({
          data: {
            tree: [
              {
                mode: "100644",
                path: "OWNERS.toml",
                sha: "owners-sha",
                type: "blob",
              },
            ],
            truncated: false,
          },
        })),
      },
      issues: {
        createComment: vi.fn<CreateComment>(async ({ body }) => ({
          data: {
            body,
            id: 100,
          },
        })),
        listComments: vi.fn<ListComments>(async () => ({ data: [] })),
        updateComment: vi.fn<UpdateComment>(async ({ body, comment_id }) => ({
          data: {
            body,
            id: comment_id,
          },
        })),
      },
      pulls: {
        listFiles: vi.fn<ListFiles>(async () => ({
          data: [{ filename: "src/index.ts" }],
        })),
        requestReviewers: vi.fn<RequestReviewers>(async () => ({})),
      },
      repos: {
        compareCommitsWithBasehead: vi.fn<CompareCommits>(async () => ({
          data: {
            files: [{ filename: "src/index.ts" }],
          },
        })),
        createCommitStatus: vi.fn<CreateCommitStatus>(async () => ({})),
      },
      teams: {
        getByName: vi.fn<GetTeam>(async () => ({
          data: {
            id: 1,
            name: "Platform",
            slug: "platform",
          },
        })),
        listMembersInOrg: vi.fn<ListMembers>(async () => ({
          data: [
            {
              id: 1,
              login: "alice",
              type: "User",
            },
          ],
        })),
      },
      users: {
        getByUsername: vi.fn<GetUser>(async ({ username }) => ({
          data: {
            id: 2,
            login: username,
            type: "User",
          },
        })),
      },
    },
  };
}

function createPullRequestPayload(action: "opened" | "synchronize") {
  return {
    action,
    before: action === "synchronize" ? "before-sha" : undefined,
    installation: {
      id: 123,
    },
    pull_request: {
      head: {
        sha: "head-sha",
      },
      labels: [],
      number: 42,
      user: {
        login: "author",
      },
    },
    repository: {
      full_name: "acme/clearance",
      name: "clearance",
      owner: {
        login: "acme",
      },
    },
    sender: {
      login: "author",
    },
  };
}
