import { App } from "@octokit/app";
import dotenv from "dotenv";

import { createDatabaseClient, DrizzleClearanceStore, type DatabaseClient } from "./db/index.js";
import { readEnv } from "./env.js";
import { runGithubEscalationSweep, type GithubEscalationRunnerOctokit } from "./github/index.js";

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

try {
  if (env.ESCALATION_REPOSITORIES.length === 0) {
    console.info("No ESCALATION_REPOSITORIES configured; nothing to process");
  } else {
    const now = new Date().toISOString();

    await Promise.all(
      env.ESCALATION_REPOSITORIES.map(async (repository) => {
        const installation = await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
          owner: repository.owner,
          repo: repository.repo,
        });
        const octokit = (await app.getInstallationOctokit(
          installation.data.id,
        )) as unknown as GithubEscalationRunnerOctokit;
        const result = await runGithubEscalationSweep(octokit, repository, now, {
          installationId: installation.data.id,
          stateStore,
        });

        console.info(result, "processed escalation sweep");
      }),
    );
  }
} finally {
  await databaseClient?.close();
}

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
