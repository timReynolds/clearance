import { Buffer } from "node:buffer";

import { Webhooks, type EmitterWebhookEvent } from "@octokit/webhooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerGithubHandlers,
  type GithubHandlerStateStore,
  type GithubHandlerReviewStore,
  type GithubInstallationClientFactory,
  type GithubWorkflowOctokit,
} from "../../src/github/handlers.js";
import { appendReviewThreadMarker } from "../../src/github/index.js";
import { parseClearanceState } from "../../src/state/index.js";

type GetBlob = GithubWorkflowOctokit["rest"]["git"]["getBlob"];
type GetTree = GithubWorkflowOctokit["rest"]["git"]["getTree"];
type GetTeam = GithubWorkflowOctokit["rest"]["teams"]["getByName"];
type ListMembers = GithubWorkflowOctokit["rest"]["teams"]["listMembersInOrg"];
type GetPull = GithubWorkflowOctokit["rest"]["pulls"]["get"];
type ListFiles = GithubWorkflowOctokit["rest"]["pulls"]["listFiles"];
type ListReviews = GithubWorkflowOctokit["rest"]["pulls"]["listReviews"];
type ListComments = GithubWorkflowOctokit["rest"]["issues"]["listComments"];
type CreateComment = GithubWorkflowOctokit["rest"]["issues"]["createComment"];
type CreateCommitStatus = GithubWorkflowOctokit["rest"]["repos"]["createCommitStatus"];
type ListCommits = GithubWorkflowOctokit["rest"]["repos"]["listCommits"];
type RequestReviewers = GithubWorkflowOctokit["rest"]["pulls"]["requestReviewers"];
type CompareCommits = GithubWorkflowOctokit["rest"]["repos"]["compareCommitsWithBasehead"];
type GetUser = GithubWorkflowOctokit["rest"]["users"]["getByUsername"];
type SearchIssues = GithubWorkflowOctokit["rest"]["search"]["issuesAndPullRequests"];
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

  it("processes submitted pull_request_review webhooks", async () => {
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
      name: "pull_request_review",
      payload: createPullRequestReviewPayload("submitted"),
    } as unknown as EmitterWebhookEvent);

    expect(octokit.rest.git.getTree).toHaveBeenCalledWith({
      owner: "acme",
      recursive: "1",
      repo: "clearance",
      tree_sha: "head-sha",
    });
    expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("<!-- clearance-state:v1"),
        issue_number: 42,
      }),
    );
  });

  it("ignores unsupported pull_request and pull_request_review actions", async () => {
    const webhooks = new Webhooks({ secret: "test-secret" });
    const getInstallationOctokit = vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
      async () => createWorkflowOctokit(),
    );

    registerGithubHandlers(webhooks, { getInstallationOctokit });

    await webhooks.receive({
      id: "delivery-id-1",
      name: "pull_request",
      payload: createPullRequestPayload("closed"),
    } as unknown as EmitterWebhookEvent);
    await webhooks.receive({
      id: "delivery-id-2",
      name: "pull_request_review",
      payload: createPullRequestReviewPayload("edited"),
    } as unknown as EmitterWebhookEvent);

    expect(getInstallationOctokit).not.toHaveBeenCalled();
  });

  it("processes override issue comments on pull requests", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const webhooks = new Webhooks({ secret: "test-secret" });
    const octokit = createWorkflowOctokit();

    registerGithubHandlers(webhooks, {
      getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
        async () => octokit,
      ),
    });

    await webhooks.receive({
      id: "delivery-id-activate",
      name: "issue_comment",
      payload: createIssueCommentPayload("@clearance override", 200),
    } as unknown as EmitterWebhookEvent);

    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: "acme",
      pull_number: 42,
      repo: "clearance",
    });
    expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "clearance/review",
        state: "success",
      }),
    );

    const createdBody = vi.mocked(octokit.rest.issues.createComment).mock.calls[0]?.[0].body;
    expect(createdBody).toEqual(expect.stringContaining("@clearance override"));
    expect(parseClearanceState(createdBody).state.override).toEqual({
      actor: "admin",
      at: expect.any(String),
      commentId: 200,
    });

    vi.mocked(octokit.rest.issues.listComments).mockResolvedValueOnce({
      data: [
        {
          body: createdBody,
          id: 100,
        },
      ],
    });

    await webhooks.receive({
      id: "delivery-id-revoke",
      name: "issue_comment",
      payload: createIssueCommentPayload("@clearance override revoke", 201),
    } as unknown as EmitterWebhookEvent);

    const updatedBody = vi.mocked(octokit.rest.issues.updateComment).mock.calls[0]?.[0].body;
    expect(parseClearanceState(updatedBody).state.override).toBeUndefined();
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "clearance/review",
        state: "pending",
      }),
    );
  });

  it("logs receipt without processing when installation data is missing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const webhooks = new Webhooks({ secret: "test-secret" });
    const getInstallationOctokit = vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
      async () => createWorkflowOctokit(),
    );
    const payload = createPullRequestPayload("opened");
    delete payload.installation;

    registerGithubHandlers(webhooks, { getInstallationOctokit });

    await webhooks.receive({
      id: "delivery-id",
      name: "pull_request",
      payload,
    } as unknown as EmitterWebhookEvent);

    expect(getInstallationOctokit).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "opened",
        pullNumber: 42,
        repository: "acme/clearance",
      }),
      "received pull request event",
    );
  });

  it("skips duplicate webhook deliveries when the state store reports an existing delivery", async () => {
    const webhooks = new Webhooks({ secret: "test-secret" });
    const getInstallationOctokit = vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
      async () => createWorkflowOctokit(),
    );
    const stateStore: GithubHandlerStateStore = {
      beginWebhookDelivery: vi.fn<NonNullable<GithubHandlerStateStore["beginWebhookDelivery"]>>(
        async () => false,
      ),
      loadPullRequestState: vi.fn<GithubHandlerStateStore["loadPullRequestState"]>(
        async () => undefined,
      ),
      savePullRequestState: vi.fn<GithubHandlerStateStore["savePullRequestState"]>(async () => {}),
    };

    registerGithubHandlers(webhooks, { getInstallationOctokit }, { stateStore });

    await webhooks.receive({
      id: "delivery-id",
      name: "pull_request",
      payload: createPullRequestPayload("opened"),
    } as unknown as EmitterWebhookEvent);

    expect(stateStore.beginWebhookDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-id",
        event: "pull_request",
      }),
    );
    expect(getInstallationOctokit).not.toHaveBeenCalled();
  });

  it("enqueues GitHub side effects when an outbox store is configured", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const webhooks = new Webhooks({ secret: "test-secret" });
    const octokit = createWorkflowOctokit();
    const stateStore: GithubHandlerStateStore = {
      beginWebhookDelivery: vi.fn<NonNullable<GithubHandlerStateStore["beginWebhookDelivery"]>>(
        async () => true,
      ),
      enqueueOutboxJob: vi.fn<NonNullable<GithubHandlerStateStore["enqueueOutboxJob"]>>(
        async () => {},
      ),
      loadPullRequestState: vi.fn<GithubHandlerStateStore["loadPullRequestState"]>(
        async () => undefined,
      ),
      recordWebhookDelivery: vi.fn<NonNullable<GithubHandlerStateStore["recordWebhookDelivery"]>>(
        async () => {},
      ),
      savePullRequestState: vi.fn<GithubHandlerStateStore["savePullRequestState"]>(async () => {}),
    };

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => octokit,
        ),
      },
      { stateStore },
    );

    await webhooks.receive({
      id: "delivery-id",
      name: "pull_request",
      payload: createPullRequestPayload("opened"),
    } as unknown as EmitterWebhookEvent);

    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
    expect(octokit.rest.repos.createCommitStatus).not.toHaveBeenCalled();
    expect(stateStore.enqueueOutboxJob).toHaveBeenCalledTimes(3);
    expect(stateStore.enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          body: expect.stringContaining("<!-- clearance-state:v1"),
          installationId: 123,
          pullNumber: 42,
        }),
        type: "github.upsert-comment",
      }),
    );
    expect(stateStore.enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          reviewers: ["alice"],
        }),
        type: "github.request-reviewers",
      }),
    );
    expect(stateStore.enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          decisions: expect.arrayContaining([
            expect.objectContaining({
              context: "clearance/config",
            }),
          ]),
        }),
        type: "github.set-statuses",
      }),
    );
  });

  it("indexes review patchsets from processed pull request webhooks", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const webhooks = new Webhooks({ secret: "test-secret" });
    const octokit = createWorkflowOctokit();
    vi.mocked(octokit.rest.pulls.listFiles).mockResolvedValue({
      data: [
        {
          additions: 4,
          deletions: 1,
          filename: "src/index.ts",
          patch: "@@ -1,1 +1,1 @@\n-export old\n+export next",
          status: "modified",
        },
      ],
    });
    const reviewStore: GithubHandlerReviewStore = {
      recordPatchset: vi.fn<GithubHandlerReviewStore["recordPatchset"]>(async () => 1),
    };

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => octokit,
        ),
      },
      { reviewStore },
    );

    await webhooks.receive({
      id: "delivery-id",
      name: "pull_request",
      payload: createPullRequestPayload("synchronize"),
    } as unknown as EmitterWebhookEvent);

    expect(reviewStore.recordPatchset).toHaveBeenCalledWith(
      {
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
      },
      expect.objectContaining({
        actor: "author",
        baseSha: "base-sha",
        eventType: "synchronize",
        files: [
          {
            additions: 4,
            deletions: 1,
            patch: "@@ -1,1 +1,1 @@\n-export old\n+export next",
            path: "src/index.ts",
            previousPath: undefined,
            status: "modified",
          },
        ],
        forcePush: false,
        headSha: "head-sha",
        parentSha: "before-sha",
      }),
    );
  });

  it("recovers Clearance review comments from GitHub review-comment webhooks", async () => {
    const webhooks = new Webhooks({ secret: "test-secret" });
    const reviewStore: GithubHandlerReviewStore = {
      ingestGithubReviewComment: vi.fn<
        NonNullable<GithubHandlerReviewStore["ingestGithubReviewComment"]>
      >(async () => true),
      recordPatchset: vi.fn<GithubHandlerReviewStore["recordPatchset"]>(async () => 1),
    };

    registerGithubHandlers(webhooks, undefined, { reviewStore });

    const body = appendReviewThreadMarker("Looks durable.", {
      commentId: "comment-1",
      threadId: "thread-1",
    });
    await webhooks.receive({
      id: "delivery-id",
      name: "pull_request_review_comment",
      payload: createReviewCommentPayload(body),
    } as unknown as EmitterWebhookEvent);

    expect(reviewStore.ingestGithubReviewComment).toHaveBeenCalledWith(
      {
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
      },
      expect.objectContaining({
        authorLogin: "alice",
        body: "Looks durable.",
        githubCommentId: 300,
        githubRootCommentId: 300,
        line: 12,
        path: "src/index.ts",
        side: "RIGHT",
        sourceText: "const durable = true;",
        threadId: "thread-1",
      }),
    );
  });

  it("keeps the root GitHub comment id when ingesting mirrored replies", async () => {
    const webhooks = new Webhooks({ secret: "test-secret" });
    const reviewStore: GithubHandlerReviewStore = {
      ingestGithubReviewComment: vi.fn<
        NonNullable<GithubHandlerReviewStore["ingestGithubReviewComment"]>
      >(async () => true),
      recordPatchset: vi.fn<GithubHandlerReviewStore["recordPatchset"]>(async () => 1),
    };

    registerGithubHandlers(webhooks, undefined, { reviewStore });

    const body = appendReviewThreadMarker("Reply stays threaded.", {
      commentId: "comment-2",
      threadId: "thread-1",
    });
    await webhooks.receive({
      id: "delivery-id",
      name: "pull_request_review_comment",
      payload: createReviewCommentPayload(body, { id: 301, inReplyToId: 300 }),
    } as unknown as EmitterWebhookEvent);

    expect(reviewStore.ingestGithubReviewComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        githubCommentId: 301,
        githubRootCommentId: 300,
        threadId: "thread-1",
      }),
    );
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

[override]
teams = ["@org/admins"]
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
        get: vi.fn<GetPull>(async () => ({
          data: {
            head: {
              sha: "head-sha",
            },
            labels: [],
            user: {
              login: "author",
            },
          },
        })),
        listFiles: vi.fn<ListFiles>(async () => ({
          data: [{ filename: "src/index.ts" }],
        })),
        listReviews: vi.fn<ListReviews>(async () => ({
          data: [],
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
        listCommits: vi.fn<ListCommits>(async () => ({
          data: [],
        })),
      },
      search: {
        issuesAndPullRequests: vi.fn<SearchIssues>(async () => ({
          data: {
            total_count: 0,
          },
        })),
      },
      teams: {
        getByName: vi.fn<GetTeam>(async () => ({
          data: {
            id: 1,
            name: "Platform",
            slug: "platform",
          },
        })),
        listMembersInOrg: vi.fn<ListMembers>(async ({ team_slug }) => ({
          data: [
            {
              id: 1,
              login: team_slug === "admins" ? "admin" : "alice",
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

function createPullRequestPayload(action: string) {
  return {
    action,
    before: action === "synchronize" ? "before-sha" : undefined,
    installation: {
      id: 123,
    } as { id: number } | undefined,
    pull_request: {
      base: {
        sha: "base-sha",
      },
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

function createPullRequestReviewPayload(action: string) {
  return {
    ...createPullRequestPayload(action),
    review: {
      state: "approved",
      user: {
        login: "alice",
      },
    },
  };
}

function createIssueCommentPayload(body: string, commentId = 200) {
  return {
    action: "created",
    comment: {
      body,
      id: commentId,
    },
    installation: {
      id: 123,
    },
    issue: {
      number: 42,
      pull_request: {
        url: "https://api.github.com/repos/acme/clearance/pulls/42",
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
      login: "admin",
    },
  };
}

function createReviewCommentPayload(
  body: string,
  options: { id?: number; inReplyToId?: number } = {},
) {
  const id = options.id ?? 300;
  return {
    action: "created",
    comment: {
      body,
      created_at: "2026-05-23T11:00:00.000Z",
      diff_hunk:
        "@@ -10,4 +10,4 @@\n const keep = true;\n const still = true;\n-const durable = false;\n+const durable = true;",
      html_url: `https://github.com/acme/clearance/pull/42#discussion_r${id}`,
      id,
      in_reply_to_id: options.inReplyToId,
      line: 12,
      node_id: "COMMENT_NODE",
      path: "src/index.ts",
      side: "RIGHT",
      user: {
        login: "alice",
      },
    },
    pull_request: {
      number: 42,
    },
    repository: {
      full_name: "acme/clearance",
      name: "clearance",
      owner: {
        login: "acme",
      },
    },
  };
}
