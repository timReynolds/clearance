import { createServer } from "node:http";

import { App } from "@octokit/app";
import { createNodeMiddleware } from "@octokit/webhooks";
import dotenv from "dotenv";

import { createDatabaseClient, DrizzleClearanceStore, type DatabaseClient } from "./db/index.js";
import { readEnv } from "./env.js";
import { registerGithubHandlers, type GithubWorkflowOctokit } from "./github/handlers.js";

dotenv.config();

const env = readEnv();

const app = new App({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  webhooks: {
    secret: env.GITHUB_WEBHOOK_SECRET,
  },
});

const databaseClient = createOptionalDatabaseClient();
const stateStore =
  databaseClient === undefined ? undefined : new DrizzleClearanceStore(databaseClient.db);

registerGithubHandlers(
  app.webhooks,
  {
    getInstallationOctokit: async (installationId) =>
      app.getInstallationOctokit(installationId) as unknown as Promise<GithubWorkflowOctokit>,
  },
  { stateStore },
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

  webhookMiddleware(request, response);
});

server.listen(env.PORT, () => {
  console.info(`Clearance listening on :${env.PORT}${env.WEBHOOK_PATH}`);
});

function createOptionalDatabaseClient(): DatabaseClient | undefined {
  if (env.DATABASE_URL === undefined) {
    console.info("DATABASE_URL is not set; using sticky comment state only");
    return undefined;
  }

  return createDatabaseClient({
    maxConnections: env.DATABASE_MAX_CONNECTIONS,
    prepareStatements: env.DATABASE_PREPARE_STATEMENTS,
    url: env.DATABASE_URL,
  });
}

async function shutdown(): Promise<void> {
  server.close();
  await databaseClient?.close();
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
