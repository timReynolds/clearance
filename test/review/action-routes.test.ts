import { Socket } from "node:net";
import { IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import type { GithubNativeReviewOctokit } from "../../src/github/review-native.js";
import type { ReviewActionStore } from "../../src/review/actions.js";
import type { DrizzleReviewAuthStore } from "../../src/review/auth.js";

const harness = vi.hoisted(() => ({
  listener: undefined as RequestListener | undefined,
  request: vi.fn<GithubNativeReviewOctokit["request"]>(),
  graphql: vi.fn<GithubNativeReviewOctokit["graphql"]>(),
  loadSession: vi.fn<DrizzleReviewAuthStore["loadSession"]>(),
  verifyCsrf: vi.fn<DrizzleReviewAuthStore["verifyCsrf"]>(),
  recordCreatedThread: vi.fn<ReviewActionStore["recordCreatedThread"]>(),
  loadThreadGithubRef: vi.fn<ReviewActionStore["loadThreadGithubRef"]>(),
  resolveThread: vi.fn<ReviewActionStore["resolveThread"]>(),
}));

vi.mock("node:http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:http")>()),
  createServer: (listener: RequestListener) => {
    harness.listener = listener;
    return { listen: vi.fn<() => void>(), close: vi.fn<() => void>() };
  },
}));
vi.mock("@octokit/core", () => ({
  Octokit: class {
    request = harness.request;
    graphql = harness.graphql;
  },
}));
vi.mock("../../src/db/index.js", () => ({
  createDatabaseClient: () => ({ db: {}, close: vi.fn<() => Promise<void>>() }),
  DrizzleClearanceStore: function () {
    return {};
  },
}));
vi.mock("../../src/review/store.js", () => ({
  DrizzleReviewStore: class {
    recordCreatedThread = harness.recordCreatedThread;
    loadThreadGithubRef = harness.loadThreadGithubRef;
    resolveThread = harness.resolveThread;
  },
}));
vi.mock("../../src/review/auth.js", () => ({
  createRandomToken: vi.fn<() => string>(),
  DrizzleReviewAuthStore: class {
    loadSession = harness.loadSession;
    verifyCsrf = harness.verifyCsrf;
  },
}));

let initialSigint: ReturnType<typeof process.listeners>;
let initialSigterm: ReturnType<typeof process.listeners>;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("GITHUB_APP_ID", "123");
  vi.stubEnv("GITHUB_PRIVATE_KEY", "unused");
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
  initialSigint = process.listeners("SIGINT");
  initialSigterm = process.listeners("SIGTERM");
  await import("../../src/server.js");
});

afterAll(() => {
  for (const listener of process.listeners("SIGINT")) {
    if (!initialSigint.includes(listener)) process.removeListener("SIGINT", listener);
  }
  for (const listener of process.listeners("SIGTERM")) {
    if (!initialSigterm.includes(listener)) process.removeListener("SIGTERM", listener);
  }
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();
  harness.loadSession.mockResolvedValue({ id: "alice-id", login: "alice", accessToken: "token" });
  harness.verifyCsrf.mockResolvedValue(true);
  harness.request.mockResolvedValue({ data: { id: 42 } });
  harness.recordCreatedThread.mockResolvedValue(true);
  harness.loadThreadGithubRef.mockResolvedValue(undefined);
});

it("returns native success and an index warning through the real comment route", async () => {
  harness.recordCreatedThread.mockRejectedValue(new Error("index unavailable"));
  const response = await post("threads", {
    body: "Comment",
    commitSha: "head",
    filePath: "src/index.ts",
  });
  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({
    ok: true,
    githubMirrored: true,
    persisted: false,
    warning: expect.any(String),
  });
});

it("rejects unauthenticated mutation requests before writing", async () => {
  harness.loadSession.mockResolvedValue(undefined);
  const response = await post("threads", {
    body: "Comment",
    commitSha: "head",
    filePath: "src/index.ts",
  });
  expect(response.status).toBe(401);
  expect(harness.request).not.toHaveBeenCalled();
  expect(harness.recordCreatedThread).not.toHaveBeenCalled();
});

it("rejects a failed CSRF check before calling a review action", async () => {
  harness.verifyCsrf.mockResolvedValue(false);
  expect((await post("threads", {})).status).toBe(403);
  expect(harness.request).not.toHaveBeenCalled();
});

it("retains request validation before native writes", async () => {
  expect((await post("threads", { body: "Comment" })).status).toBe(400);
  expect(harness.request).not.toHaveBeenCalled();
});

it("adapts a missing native resolution reference to conflict without changing the index", async () => {
  expect((await post("threads/missing-thread/resolve", {})).status).toBe(409);
  expect(harness.resolveThread).not.toHaveBeenCalled();
  expect(harness.graphql).not.toHaveBeenCalled();
});

async function post(action: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const request = new IncomingMessage(new Socket());
  request.method = "POST";
  request.url = `/api/review/acme/widget/pull/17/${action}`;
  request.headers = { cookie: "clearance_review_session=session", "x-clearance-csrf": "csrf" };
  request.push(Buffer.from(JSON.stringify(body)));
  request.push(null);
  return new Promise((resolve) => {
    let status = 0;
    const response = {
      writeHead(code: number) {
        status = code;
      },
      end(responseBody: string) {
        resolve({ status, body: JSON.parse(responseBody) });
      },
    } as ServerResponse;
    if (harness.listener === undefined)
      throw new Error("server did not register a request listener");
    harness.listener(request, response);
  });
}
