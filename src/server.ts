import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { OAuthApp } from "@octokit/oauth-app";
import { createNodeMiddleware } from "@octokit/webhooks";
import dotenv from "dotenv";

import { createDatabaseClient, DrizzleClearanceStore } from "./db/index.js";
import { readEnv } from "./env.js";
import { registerGithubHandlers, type GithubWorkflowOctokit } from "./github/handlers.js";
import {
  createGithubReviewThreadComment,
  findGithubPullRequestNodeId,
  markGithubFileViewed,
  replyToGithubReviewThread,
  resolveGithubReviewThread,
  serializeReviewThreadMarker,
  submitGithubPullRequestApproval,
  type GithubReviewCommentMirror,
} from "./github/index.js";
import { createInstallationOctokit } from "./github/installation-client.js";
import {
  createDemoReviewSnapshot,
  createRandomToken,
  DrizzleReviewAuthStore,
  DrizzleReviewStore,
  getPublicThreadRootCommentId,
  loadPublicReviewSnapshot,
  type AttentionPassRequest,
  type CreateThreadRequest,
  type MarkReviewedRequest,
  type ReplyThreadRequest,
  type SubmitReviewRequest,
} from "./review/index.js";

dotenv.config();

const env = readEnv();

const app = new App({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  webhooks: {
    secret: env.GITHUB_WEBHOOK_SECRET,
  },
});

const databaseClient = createDatabaseClient({
  maxConnections: env.DATABASE_MAX_CONNECTIONS,
  prepareStatements: env.DATABASE_PREPARE_STATEMENTS,
  url: env.DATABASE_URL,
});
const stateStore = new DrizzleClearanceStore(databaseClient.db);
const reviewStore = new DrizzleReviewStore(databaseClient.db);
const reviewAuthStore = new DrizzleReviewAuthStore(databaseClient.db, {
  sessionSecret: env.REVIEW_SESSION_SECRET ?? env.GITHUB_WEBHOOK_SECRET,
  tokenEncryptionKey:
    env.REVIEW_TOKEN_ENCRYPTION_KEY ?? env.REVIEW_SESSION_SECRET ?? env.GITHUB_WEBHOOK_SECRET,
});
const reviewOAuthApp = createOptionalReviewOAuthApp();
const publicDirectory = fileURLToPath(new URL("./public", import.meta.url));

registerGithubHandlers(
  app.webhooks,
  {
    getInstallationOctokit: async (installationId) =>
      createInstallationOctokit(app, installationId) as unknown as Promise<GithubWorkflowOctokit>,
  },
  { reviewStore, stateStore },
);

const webhookMiddleware = createNodeMiddleware(app.webhooks, {
  path: env.WEBHOOK_PATH,
});

const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.url?.startsWith("/api/me") === true) {
    void handleMeApiRequest(request, response);
    return;
  }

  if (request.url?.startsWith("/auth/github/start") === true) {
    void handleGithubOAuthStart(request, response);
    return;
  }

  if (request.url?.startsWith("/auth/github/callback") === true) {
    void handleGithubOAuthCallback(request, response);
    return;
  }

  if (request.url?.startsWith("/auth/logout") === true) {
    void handleLogout(request, response);
    return;
  }

  if (request.url?.startsWith("/api/review/") === true) {
    void handleReviewApiRequest(request, response);
    return;
  }

  if (
    request.method === "GET" &&
    (request.url === "/" ||
      request.url?.startsWith("/review/") === true ||
      request.url?.startsWith("/assets/") === true)
  ) {
    void servePublicAsset(request, response);
    return;
  }

  webhookMiddleware(request, response);
});

server.listen(env.PORT, () => {
  console.info(`Clearance listening on :${env.PORT}${env.WEBHOOK_PATH}`);
});

function createOptionalReviewOAuthApp(): OAuthApp<{ clientType: "github-app" }> | undefined {
  if (env.GITHUB_CLIENT_ID === undefined || env.GITHUB_CLIENT_SECRET === undefined) {
    return undefined;
  }

  return new OAuthApp({
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    clientType: "github-app",
  });
}

async function shutdown(): Promise<void> {
  server.close();
  await databaseClient.close();
}

async function handleMeApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const actor = await getReviewActor(request);
  const returnTo = normalizeReturnTo(getRequestUrl(request).searchParams.get("returnTo"));
  writeJson(response, 200, {
    authenticated: actor.authenticated,
    csrfToken: actor.csrfToken,
    loginUrl:
      reviewOAuthApp === undefined || reviewAuthStore === undefined
        ? undefined
        : `/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`,
    viewer:
      actor.login === undefined ? undefined : { avatarUrl: actor.avatarUrl, login: actor.login },
  });
}

async function handleGithubOAuthStart(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (reviewOAuthApp === undefined || reviewAuthStore === undefined) {
    writeJson(response, 501, {
      error: "GitHub OAuth requires GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and DATABASE_URL",
    });
    return;
  }

  const url = getRequestUrl(request);
  const nonce = createRandomToken();
  const state = encodeOAuthState({
    nonce,
    returnTo: normalizeReturnTo(url.searchParams.get("returnTo")),
  });
  const { url: authorizationUrl } = reviewOAuthApp.getWebFlowAuthorizationUrl({
    redirectUrl: getGithubOAuthCallbackUrl(request),
    state,
  });

  appendSetCookie(
    response,
    serializeCookie(env.REVIEW_OAUTH_STATE_COOKIE_NAME, nonce, {
      httpOnly: true,
      maxAgeSeconds: 10 * 60,
      path: "/auth/github",
      sameSite: "Lax",
      secure: isSecureRequest(request),
    }),
  );
  redirect(response, authorizationUrl);
}

async function handleGithubOAuthCallback(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (reviewOAuthApp === undefined || reviewAuthStore === undefined) {
    writeJson(response, 501, {
      error: "GitHub OAuth requires GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and DATABASE_URL",
    });
    return;
  }

  const url = getRequestUrl(request);
  if (url.searchParams.has("error")) {
    writeJson(response, 400, {
      error: url.searchParams.get("error_description") ?? url.searchParams.get("error"),
    });
    return;
  }

  const code = url.searchParams.get("code");
  const stateValue = url.searchParams.get("state");
  const state = decodeOAuthState(stateValue);
  const expectedNonce = parseCookies(request)[env.REVIEW_OAUTH_STATE_COOKIE_NAME];
  if (
    code === null ||
    state === undefined ||
    expectedNonce === undefined ||
    state.nonce !== expectedNonce
  ) {
    writeJson(response, 400, { error: "invalid OAuth callback state" });
    return;
  }

  const { authentication } = await reviewOAuthApp.createToken({
    code,
    redirectUrl: getGithubOAuthCallbackUrl(request),
    state: stateValue ?? undefined,
  });
  const githubUser = await loadGithubViewer(authentication.token);
  const reviewUser = await reviewAuthStore.upsertUserToken({
    accessToken: authentication.token,
    avatarUrl: githubUser.avatarUrl,
    expiresAt: authentication.expiresAt,
    githubLogin: githubUser.login,
    githubUserId: githubUser.id,
    refreshToken: authentication.refreshToken,
    refreshTokenExpiresAt: authentication.refreshTokenExpiresAt,
  });
  const sessionToken = createRandomToken();
  const csrfToken = createRandomToken();
  const maxAgeSeconds = 60 * 60 * 24 * 30;
  await reviewAuthStore.createSession({
    csrfToken,
    expiresAt: new Date(Date.now() + maxAgeSeconds * 1000).toISOString(),
    sessionToken,
    userId: reviewUser.id,
  });

  appendSetCookie(response, clearCookie(env.REVIEW_OAUTH_STATE_COOKIE_NAME, "/auth/github"));
  appendSetCookie(
    response,
    serializeCookie(env.REVIEW_SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      maxAgeSeconds,
      path: "/",
      sameSite: "Lax",
      secure: isSecureRequest(request),
    }),
  );
  appendSetCookie(
    response,
    serializeCookie(env.REVIEW_CSRF_COOKIE_NAME, csrfToken, {
      httpOnly: false,
      maxAgeSeconds,
      path: "/",
      sameSite: "Lax",
      secure: isSecureRequest(request),
    }),
  );
  redirect(response, state.returnTo);
}

async function handleLogout(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const sessionToken = parseCookies(request)[env.REVIEW_SESSION_COOKIE_NAME];
  if (sessionToken !== undefined) {
    await reviewAuthStore?.deleteSession(sessionToken);
  }

  appendSetCookie(response, clearCookie(env.REVIEW_SESSION_COOKIE_NAME, "/"));
  appendSetCookie(response, clearCookie(env.REVIEW_CSRF_COOKIE_NAME, "/"));
  redirect(response, "/");
}

async function handleReviewApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = getRequestUrl(request);
  const route = parseReviewRoute(url.pathname);
  if (route === undefined) {
    writeJson(response, 404, { error: "review route not found" });
    return;
  }

  const actor = await getReviewActor(request);
  const viewerLogin = actor.login;

  if (request.method === "GET" && route.action === undefined) {
    try {
      const snapshot =
        (actor.authenticated
          ? await reviewStore?.loadSnapshot(route, viewerLogin, {
              fromPatchsetNumber: getOptionalPositiveInteger(url.searchParams.get("from")),
              toPatchsetNumber: getOptionalPositiveInteger(url.searchParams.get("to")),
            })
          : undefined) ??
        (await loadPublicReviewSnapshot(
          createGithubReadOctokit(actor.accessToken),
          route,
          viewerLogin,
        ));

      if (snapshot !== undefined) {
        writeJson(response, 200, snapshot);
        return;
      }

      if (isDemoReviewRoute(route)) {
        writeJson(
          response,
          200,
          createDemoReviewSnapshot({
            owner: route.owner,
            pullNumber: route.pullNumber,
            repo: route.repo,
            viewerLogin,
          }),
        );
        return;
      }

      writeJson(response, 404, {
        error: "Pull request was not found, is private, or is unavailable to the GitHub API.",
      });
    } catch (error) {
      writeJson(response, 502, {
        error: getErrorMessage(error, "failed to load public pull request from GitHub"),
      });
    }
    return;
  }

  if (!(await requireReviewCsrf(request, response, actor))) {
    return;
  }

  const actorLogin = getAuthenticatedReviewLogin(actor);
  if (actorLogin === undefined) {
    writeJson(response, 401, { error: "Sign in with GitHub to change review state." });
    return;
  }

  if (request.method === "POST" && route.action === "marks") {
    const body = await readJsonBody<MarkReviewedRequest>(request);
    if (
      body === undefined ||
      typeof body.filePath !== "string" ||
      typeof body.patchsetNumber !== "number"
    ) {
      writeJson(response, 400, { error: "expected filePath and patchsetNumber" });
      return;
    }

    const persisted = (await reviewStore?.markFileReviewed(route, actorLogin, body)) ?? false;
    let githubMirrored = false;
    if (actor.accessToken !== undefined) {
      const octokit = createUserOctokit(actor.accessToken);
      const pullRequestNodeId =
        body.pullRequestNodeId ?? (await findGithubPullRequestNodeId(octokit, route));
      if (pullRequestNodeId !== undefined) {
        await markGithubFileViewed(octokit, pullRequestNodeId, body.filePath);
        githubMirrored = true;
      }
    }

    writeJson(response, 202, { ok: true, githubMirrored, persisted });
    return;
  }

  if (request.method === "POST" && route.action === "attention/pass") {
    const body = await readJsonBody<AttentionPassRequest>(request);
    if (body === undefined || typeof body.targetLogin !== "string") {
      writeJson(response, 400, { error: "expected targetLogin" });
      return;
    }

    const persisted = (await reviewStore?.passAttention(route, actorLogin, body)) ?? false;
    writeJson(response, 202, { ok: true, persisted });
    return;
  }

  if (request.method === "POST" && route.action === "attention/not-my-turn") {
    const persisted = (await reviewStore?.markNotMyTurn(route, actorLogin)) ?? false;
    writeJson(response, 202, { ok: true, persisted });
    return;
  }

  if (request.method === "POST" && route.action === "threads") {
    const body = await readJsonBody<CreateThreadRequest>(request);
    if (
      body === undefined ||
      !isNonEmptyString(body.body) ||
      !isNonEmptyString(body.commitSha) ||
      !isNonEmptyString(body.filePath) ||
      !isOptionalPositiveInteger(body.line) ||
      !isOptionalPositiveInteger(body.patchsetNumber) ||
      !isOptionalReviewSide(body.side)
    ) {
      writeJson(response, 400, {
        error: "expected body, commitSha, filePath, and optional line/side/patchsetNumber",
      });
      return;
    }

    const threadId = randomUUID();
    const commentId = randomUUID();
    const marker = { commentId, threadId };
    const github = await mirrorCreateThread(actor.accessToken, route, body, marker);
    const persisted =
      (await reviewStore?.recordCreatedThread(route, actorLogin, body, {
        commentId,
        github,
        marker: serializeReviewThreadMarker(marker),
        threadId,
        threadMarker: serializeReviewThreadMarker({ threadId }),
      })) ?? false;

    if (github === undefined && !persisted) {
      writeJson(response, 401, {
        error:
          "Public pull request comments require GitHub sign-in or an indexed Clearance database.",
      });
      return;
    }

    writeJson(response, 201, {
      githubMirrored: github !== undefined,
      ok: true,
      persisted,
      threadId,
    });
    return;
  }

  if (
    request.method === "POST" &&
    route.threadId !== undefined &&
    route.action === "threads/replies"
  ) {
    const body = await readJsonBody<ReplyThreadRequest>(request);
    if (body === undefined || !isNonEmptyString(body.body)) {
      writeJson(response, 400, { error: "expected body" });
      return;
    }

    const commentId = randomUUID();
    const marker = { commentId, threadId: route.threadId };
    const github = await mirrorThreadReply(actor.accessToken, route, route.threadId, body, marker);
    const persisted =
      (await reviewStore?.recordThreadReply(route, actorLogin, route.threadId, body, {
        commentId,
        github,
        marker: serializeReviewThreadMarker(marker),
      })) ?? false;

    if (github === undefined && !persisted) {
      writeJson(response, 401, {
        error: "Public pull request replies require GitHub sign-in or an indexed Clearance thread.",
      });
      return;
    }

    writeJson(response, 201, {
      githubMirrored: github !== undefined,
      ok: true,
      persisted,
    });
    return;
  }

  if (
    request.method === "POST" &&
    route.threadId !== undefined &&
    route.action === "threads/resolve"
  ) {
    const githubResolved = await mirrorThreadResolution(actor.accessToken, route, route.threadId);
    const persisted =
      (await reviewStore?.resolveThread(route, actorLogin, route.threadId)) ?? false;
    if (!githubResolved && !persisted) {
      writeJson(response, 409, {
        error: "Resolving imported public threads requires indexed GitHub review-thread state.",
      });
      return;
    }

    writeJson(response, 202, { githubResolved, ok: true, persisted });
    return;
  }

  if (request.method === "POST" && route.action === "reviews/approve") {
    const body = await readJsonBody<SubmitReviewRequest>(request);
    if (actor.accessToken === undefined) {
      writeJson(response, 401, { error: "sign in with GitHub to approve on GitHub" });
      return;
    }

    await submitGithubPullRequestApproval(
      createUserOctokit(actor.accessToken),
      route,
      body?.body ?? "Reviewed in Clearance.",
    );
    await reviewStore?.markNotMyTurn(route, actorLogin);

    writeJson(response, 202, { githubMirrored: true, ok: true });
    return;
  }

  writeJson(response, 404, { error: "review action not found" });
}

function isDemoReviewRoute(route: Pick<ReviewPullRequestApiRoute, "owner" | "repo">): boolean {
  return route.owner === "acme" && route.repo === "repo";
}

/*
 * The public snapshot path uses GitHub REST directly. It intentionally does not
 * require a GitHub App installation; OAuth is used only when the viewer has
 * signed in, mostly for rate limits and permitted review actions.
 */
function createGithubReadOctokit(accessToken: string | undefined): Octokit {
  return accessToken === undefined ? new Octokit() : createUserOctokit(accessToken);
}

function parseReviewRoute(pathname: string):
  | {
      action?:
        | "attention/not-my-turn"
        | "attention/pass"
        | "marks"
        | "reviews/approve"
        | "threads"
        | "threads/replies"
        | "threads/resolve";
      owner: string;
      pullNumber: number;
      repo: string;
      threadId?: string;
    }
  | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (
    segments[0] !== "api" ||
    segments[1] !== "review" ||
    segments[4] !== "pull" ||
    segments[2] === undefined ||
    segments[3] === undefined ||
    segments[5] === undefined
  ) {
    return undefined;
  }

  const pullNumber = Number.parseInt(segments[5], 10);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    return undefined;
  }

  const actionSegments = segments.slice(6);
  const normalizedAction = normalizeReviewAction(actionSegments);
  if (normalizedAction === null) {
    return undefined;
  }

  return {
    action: normalizedAction,
    owner: segments[2],
    pullNumber,
    repo: segments[3],
    threadId: actionSegments[0] === "threads" ? actionSegments[1] : undefined,
  };
}

function normalizeReviewAction(segments: string[]): ReviewPullRequestApiRoute["action"] | null {
  const action = segments.join("/");
  if (action === "") {
    return undefined;
  }

  if (
    action === "marks" ||
    action === "attention/pass" ||
    action === "attention/not-my-turn" ||
    action === "threads" ||
    action === "reviews/approve"
  ) {
    return action;
  }

  if (segments[0] === "threads" && segments[1] !== undefined && segments[3] === undefined) {
    if (segments[2] === "replies") {
      return "threads/replies";
    }

    if (segments[2] === "resolve") {
      return "threads/resolve";
    }
  }

  return null;
}

type ReviewPullRequestApiRoute = NonNullable<ReturnType<typeof parseReviewRoute>>;

type ReviewActor = {
  accessToken?: string;
  authenticated: boolean;
  avatarUrl?: string;
  csrfToken?: string;
  login?: string;
  sessionToken?: string;
};

type ReviewOAuthState = {
  nonce: string;
  returnTo: string;
};

function getRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://clearance.local");
}

async function getReviewActor(request: IncomingMessage): Promise<ReviewActor> {
  const cookies = parseCookies(request);
  const sessionToken = cookies[env.REVIEW_SESSION_COOKIE_NAME];
  if (sessionToken !== undefined && reviewAuthStore !== undefined) {
    const user = await reviewAuthStore.loadSession(sessionToken);
    if (user !== undefined) {
      return {
        accessToken: user.accessToken,
        authenticated: true,
        avatarUrl: user.avatarUrl,
        csrfToken: cookies[env.REVIEW_CSRF_COOKIE_NAME],
        login: user.login,
        sessionToken,
      };
    }
  }

  return {
    authenticated: false,
    login: getViewerLogin(request),
  };
}

function getViewerLogin(request: IncomingMessage): string | undefined {
  const header = request.headers["x-clearance-user"];
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

function getAuthenticatedReviewLogin(actor: ReviewActor): string | undefined {
  return actor.authenticated && actor.login !== undefined ? actor.login : undefined;
}

async function requireReviewCsrf(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ReviewActor,
): Promise<boolean> {
  if (!actor.authenticated || actor.sessionToken === undefined || reviewAuthStore === undefined) {
    return true;
  }

  const csrfToken = getHeader(request, "x-clearance-csrf");
  if (
    csrfToken === undefined ||
    !(await reviewAuthStore.verifyCsrf({ csrfToken, sessionToken: actor.sessionToken }))
  ) {
    writeJson(response, 403, { error: "invalid CSRF token" });
    return false;
  }

  return true;
}

async function mirrorCreateThread(
  accessToken: string | undefined,
  ref: ReviewPullRequestApiRoute,
  body: CreateThreadRequest,
  marker: { commentId: string; threadId: string },
): Promise<GithubReviewCommentMirror | undefined> {
  if (accessToken === undefined) {
    return undefined;
  }

  return createGithubReviewThreadComment(createUserOctokit(accessToken), ref, body, marker);
}

async function mirrorThreadReply(
  accessToken: string | undefined,
  ref: ReviewPullRequestApiRoute,
  threadId: string,
  body: ReplyThreadRequest,
  marker: { commentId: string; threadId: string },
): Promise<GithubReviewCommentMirror | undefined> {
  if (accessToken === undefined) {
    return undefined;
  }

  const githubRef = await reviewStore?.loadThreadGithubRef(ref, threadId);
  const firstCommentId = githubRef?.firstCommentId ?? getPublicThreadRootCommentId(threadId);
  if (firstCommentId === undefined) {
    return undefined;
  }

  return replyToGithubReviewThread(
    createUserOctokit(accessToken),
    ref,
    firstCommentId,
    body.body,
    marker,
  );
}

async function mirrorThreadResolution(
  accessToken: string | undefined,
  ref: ReviewPullRequestApiRoute,
  threadId: string,
): Promise<boolean> {
  if (accessToken === undefined) {
    return false;
  }

  const githubRef = await reviewStore?.loadThreadGithubRef(ref, threadId);
  if (githubRef?.threadNodeId === undefined) {
    return false;
  }

  await resolveGithubReviewThread(createUserOctokit(accessToken), githubRef.threadNodeId);
  return true;
}

function createUserOctokit(accessToken: string): Octokit {
  return new Octokit({ auth: accessToken });
}

async function loadGithubViewer(accessToken: string): Promise<{
  avatarUrl?: string;
  id?: number;
  login: string;
}> {
  const response = await createUserOctokit(accessToken).request("GET /user");
  const user = response.data as { avatar_url?: string; id?: number; login?: string };
  if (!isNonEmptyString(user.login)) {
    throw new Error("GitHub OAuth token did not return a viewer login");
  }

  return {
    avatarUrl: user.avatar_url,
    id: user.id,
    login: user.login,
  };
}

function getGithubOAuthCallbackUrl(request: IncomingMessage): string {
  return `${getRequestOrigin(request)}/auth/github/callback`;
}

function getRequestOrigin(request: IncomingMessage): string {
  const host = getHeader(request, "x-forwarded-host") ?? getHeader(request, "host") ?? "localhost";
  const proto =
    getHeader(request, "x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function getHeader(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers[name];
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

function parseCookies(request: IncomingMessage): Record<string, string> {
  const header = getHeader(request, "cookie");
  if (header === undefined) {
    return {};
  }

  const cookies: Record<string, string> = {};
  for (const entry of header.split(";")) {
    const [name, ...valueParts] = entry.trim().split("=");
    if (name === undefined || name === "") {
      continue;
    }

    cookies[decodeURIComponent(name)] = decodeURIComponent(valueParts.join("="));
  }

  return cookies;
}

function appendSetCookie(response: ServerResponse, cookie: string): void {
  const existing = response.getHeader("set-cookie");
  if (existing === undefined) {
    response.setHeader("set-cookie", cookie);
  } else if (Array.isArray(existing)) {
    response.setHeader("set-cookie", [...existing.map(String), cookie]);
  } else {
    response.setHeader("set-cookie", [String(existing), cookie]);
  }
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly: boolean;
    maxAgeSeconds: number;
    path: string;
    sameSite: "Lax" | "Strict";
    secure: boolean;
  },
): string {
  const parts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAgeSeconds}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function clearCookie(name: string, path: string): string {
  return `${encodeURIComponent(name)}=; Path=${path}; Max-Age=0; SameSite=Lax`;
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location });
  response.end();
}

function isSecureRequest(request: IncomingMessage): boolean {
  return getHeader(request, "x-forwarded-proto") === "https";
}

function normalizeReturnTo(value: string | null): string {
  if (value === null || value.trim() === "") {
    return "/";
  }

  try {
    const url = new URL(value, "http://clearance.local");
    if (url.origin !== "http://clearance.local") {
      return "/";
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function encodeOAuthState(state: ReviewOAuthState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeOAuthState(value: string | null): ReviewOAuthState | undefined {
  if (value === null) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isReviewOAuthState(parsed)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

function isReviewOAuthState(value: unknown): value is ReviewOAuthState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.nonce === "string" && typeof record.returnTo === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

function isOptionalReviewSide(value: unknown): value is "LEFT" | "RIGHT" | undefined {
  return value === undefined || value === "LEFT" || value === "RIGHT";
}

function getOptionalPositiveInteger(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function servePublicAsset(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = getRequestUrl(request);
  const requestedPath = url.pathname.startsWith("/assets/") ? url.pathname.slice(1) : "index.html";
  const filePath = normalize(join(publicDirectory, requestedPath));

  if (filePath !== publicDirectory && !filePath.startsWith(`${publicDirectory}${sep}`)) {
    response.writeHead(403);
    response.end();
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error("not a file");
    }

    response.writeHead(200, { "content-type": getContentType(filePath) });
    createReadStream(filePath).pipe(response);
  } catch {
    const indexPath = join(publicDirectory, "index.html");
    try {
      await stat(indexPath);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      createReadStream(indexPath).pipe(response);
    } catch {
      response.writeHead(404);
      response.end();
    }
  }
}

function getContentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
