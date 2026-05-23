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
import { parseClearanceState, type ClearanceState } from "../../src/state/index.js";

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
    const stateStore = createStateStore();

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => octokit,
        ),
      },
      createHandlerOptions(stateStore),
    );

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
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.repos.createCommitStatus).not.toHaveBeenCalled();
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
              state: "success",
            }),
          ]),
        }),
        type: "github.set-statuses",
      }),
    );
  });

  it("uses dry-run mode to update only the sticky comment", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const webhooks = new Webhooks({ secret: "test-secret" });
    const octokit = createWorkflowOctokit({ dryRun: true });
    const stateStore = createStateStore();

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => octokit,
        ),
      },
      createHandlerOptions(stateStore),
    );

    await webhooks.receive({
      id: "delivery-id",
      name: "pull_request",
      payload: createPullRequestPayload("opened"),
    } as unknown as EmitterWebhookEvent);

    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(stateStore.enqueueOutboxJob).toHaveBeenCalledTimes(1);
    expect(stateStore.enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          body: expect.stringContaining("Dry run mode is active."),
          pullNumber: 42,
        }),
        type: "github.upsert-comment",
      }),
    );
    expect(octokit.rest.repos.createCommitStatus).not.toHaveBeenCalled();
  });

  it("uses GitHub compare data for synchronize scoped invalidation", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const webhooks = new Webhooks({ secret: "test-secret" });
    const octokit = createWorkflowOctokit();
    const stateStore = createStateStore();

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => octokit,
        ),
      },
      createHandlerOptions(stateStore),
    );

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
    const stateStore = createStateStore();

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => octokit,
        ),
      },
      createHandlerOptions(stateStore),
    );

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
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(stateStore.enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          body: expect.stringContaining("<!-- clearance-state:v1"),
          pullNumber: 42,
        }),
        type: "github.upsert-comment",
      }),
    );
  });

  it("revokes stored approvals from dismissed pull_request_review webhooks", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const webhooks = new Webhooks({ secret: "test-secret" });
    const octokit = createWorkflowOctokit();
    const stateStore = createStateStore({
      initialState: {
        approvals: [
          {
            approvedAt: "2026-05-17T10:00:00.000Z",
            headSha: "head-sha",
            requirementIdentity: "and:.:@org/platform:1",
            reviewer: "alice",
          },
        ],
        assignments: [],
        escalations: [],
        fallbackNotifications: [],
        notificationsSent: [],
        requirements: [],
        version: 1,
        warnings: [],
      },
    });

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => octokit,
        ),
      },
      createHandlerOptions(stateStore),
    );

    await webhooks.receive({
      id: "delivery-id",
      name: "pull_request_review",
      payload: createPullRequestReviewPayload("dismissed"),
    } as unknown as EmitterWebhookEvent);

    expect(stateStore.savedState?.approvals).toEqual([]);
    expect(stateStore.savedState?.requirements[0]).toEqual(
      expect.objectContaining({
        approvedBy: [],
        status: "pending",
      }),
    );
  });

  it("ignores unsupported pull_request and pull_request_review actions", async () => {
    const webhooks = new Webhooks({ secret: "test-secret" });
    const getInstallationOctokit = vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
      async () => createWorkflowOctokit(),
    );
    const stateStore = createStateStore();

    registerGithubHandlers(webhooks, { getInstallationOctokit }, createHandlerOptions(stateStore));

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
    const stateStore = createStateStore();

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => octokit,
        ),
      },
      createHandlerOptions(stateStore),
    );

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
    expect(octokit.rest.repos.createCommitStatus).not.toHaveBeenCalled();
    expect(stateStore.enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          decisions: expect.arrayContaining([
            expect.objectContaining({
              context: "clearance/review",
              state: "success",
            }),
          ]),
        }),
        type: "github.set-statuses",
      }),
    );

    const createdBody = stateStore.jobs.find((job) => job.type === "github.upsert-comment")?.payload
      .body;
    expect(createdBody).toEqual(expect.stringContaining("@clearance override"));
    expect(parseClearanceState(String(createdBody)).state.override).toEqual({
      actor: "admin",
      at: expect.any(String),
      commentId: 200,
    });

    await webhooks.receive({
      id: "delivery-id-revoke",
      name: "issue_comment",
      payload: createIssueCommentPayload("@clearance override revoke", 201),
    } as unknown as EmitterWebhookEvent);

    const latestUpsertBody = stateStore.jobs.findLast((job) => job.type === "github.upsert-comment")
      ?.payload.body;
    expect(parseClearanceState(String(latestUpsertBody)).state.override).toBeUndefined();
    expect(stateStore.enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          decisions: expect.arrayContaining([
            expect.objectContaining({
              context: "clearance/review",
              state: "pending",
            }),
          ]),
        }),
        type: "github.set-statuses",
      }),
    );
  });

  it("logs receipt without processing when installation data is missing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const webhooks = new Webhooks({ secret: "test-secret" });
    const getInstallationOctokit = vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
      async () => createWorkflowOctokit(),
    );
    const stateStore = createStateStore();
    const payload = createPullRequestPayload("opened");
    delete payload.installation;

    registerGithubHandlers(webhooks, { getInstallationOctokit }, createHandlerOptions(stateStore));

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
    const stateStore = createStateStore({ beginWebhookDelivery: async () => false });

    registerGithubHandlers(webhooks, { getInstallationOctokit }, createHandlerOptions(stateStore));

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

  it("enqueues GitHub side effects through the state store", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const webhooks = new Webhooks({ secret: "test-secret" });
    const octokit = createWorkflowOctokit();
    const stateStore = createStateStore();

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => octokit,
        ),
      },
      createHandlerOptions(stateStore),
    );

    await webhooks.receive({
      id: "delivery-id",
      name: "pull_request",
      payload: createPullRequestPayload("opened"),
    } as unknown as EmitterWebhookEvent);

    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
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
    const reviewStore = createReviewStore({
      recordPatchset: vi.fn<GithubHandlerReviewStore["recordPatchset"]>(async () => 1),
    });
    const stateStore = createStateStore();

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => octokit,
        ),
      },
      { reviewStore, stateStore },
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
    const stateStore = createStateStore();

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => createWorkflowOctokit(),
        ),
      },
      { reviewStore, stateStore },
    );

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
    const stateStore = createStateStore();

    registerGithubHandlers(
      webhooks,
      {
        getInstallationOctokit: vi.fn<GithubInstallationClientFactory["getInstallationOctokit"]>(
          async () => createWorkflowOctokit(),
        ),
      },
      { reviewStore, stateStore },
    );

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

type TestStateStore = GithubHandlerStateStore & {
  jobs: Array<Parameters<GithubHandlerStateStore["enqueueOutboxJob"]>[0]>;
  savedState?: ClearanceState;
};

function createStateStore(
  options: {
    beginWebhookDelivery?: GithubHandlerStateStore["beginWebhookDelivery"];
    initialState?: ClearanceState;
  } = {},
): TestStateStore {
  const jobs: TestStateStore["jobs"] = [];
  let savedState = options.initialState;
  const store: TestStateStore = {
    beginWebhookDelivery: vi.fn<GithubHandlerStateStore["beginWebhookDelivery"]>(
      options.beginWebhookDelivery ?? (async () => true),
    ),
    enqueueOutboxJob: vi.fn<GithubHandlerStateStore["enqueueOutboxJob"]>(async (job) => {
      jobs.push(job);
    }),
    jobs,
    loadPullRequestState: vi.fn<GithubHandlerStateStore["loadPullRequestState"]>(
      async () => savedState,
    ),
    recordWebhookDelivery: vi.fn<GithubHandlerStateStore["recordWebhookDelivery"]>(async () => {}),
    savePullRequestState: vi.fn<GithubHandlerStateStore["savePullRequestState"]>(
      async (_input, state) => {
        savedState = state;
        store.savedState = state;
      },
    ),
    savedState,
  };

  return store;
}

function createHandlerOptions(
  stateStore: GithubHandlerStateStore,
  reviewStore = createReviewStore(),
): { reviewStore: GithubHandlerReviewStore; stateStore: GithubHandlerStateStore } {
  return { reviewStore, stateStore };
}

function createReviewStore(
  overrides: Partial<GithubHandlerReviewStore> = {},
): GithubHandlerReviewStore {
  return {
    ingestGithubReviewComment: vi.fn<GithubHandlerReviewStore["ingestGithubReviewComment"]>(
      async () => true,
    ),
    recordPatchset: vi.fn<GithubHandlerReviewStore["recordPatchset"]>(async () => 1),
    ...overrides,
  };
}

function createWorkflowOctokit(options: { dryRun?: boolean } = {}): GithubWorkflowOctokit {
  return {
    rest: {
      git: {
        getBlob: vi.fn<GetBlob>(async () => ({
          data: {
            content: Buffer.from(
              `
${options.dryRun === true ? "dry_run = true\n" : ""}
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
