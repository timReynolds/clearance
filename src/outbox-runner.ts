import { App } from "@octokit/app";
import dotenv from "dotenv";

import { createDatabaseClient, DrizzleClearanceStore } from "./db/index.js";
import { readEnv } from "./env.js";
import { runGithubOutboxOnce, type GithubOutboxOctokit } from "./github/index.js";

dotenv.config();

const env = readEnv();

if (env.DATABASE_URL === undefined) {
  throw new Error("DATABASE_URL is required to process the outbox");
}

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
const store = new DrizzleClearanceStore(databaseClient.db);
let shuttingDown = false;

process.once("SIGINT", () => {
  shuttingDown = true;
});
process.once("SIGTERM", () => {
  shuttingDown = true;
});

try {
  await runOutbox();
} finally {
  await databaseClient.close();
}

async function runOutbox(): Promise<void> {
  const result = await runGithubOutboxOnce(
    {
      getInstallationOctokit: async (installationId) =>
        app.getInstallationOctokit(installationId) as unknown as Promise<GithubOutboxOctokit>,
    },
    store,
    {
      batchSize: env.OUTBOX_BATCH_SIZE,
      maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    },
  );

  console.info(result, "processed outbox jobs");

  if (env.OUTBOX_POLL_INTERVAL_MS === 0 || shuttingDown) {
    return;
  }

  await sleep(env.OUTBOX_POLL_INTERVAL_MS);
  if (!shuttingDown) {
    await runOutbox();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
