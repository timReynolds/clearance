import { App } from "@octokit/app";
import dotenv from "dotenv";

import { createDatabaseClient, DrizzleClearanceStore } from "./db/index.js";
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

if (env.DATABASE_URL === undefined) {
  throw new Error("DATABASE_URL is required to run escalation sweeps");
}

const databaseClient = createDatabaseClient({
  maxConnections: env.DATABASE_MAX_CONNECTIONS,
  prepareStatements: env.DATABASE_PREPARE_STATEMENTS,
  url: env.DATABASE_URL,
});
const stateStore = new DrizzleClearanceStore(databaseClient.db);

try {
  const repositories = await stateStore.listTrackedRepositories();

  if (repositories.length === 0) {
    console.info("No tracked Clearance repositories found in the database; nothing to process");
  } else {
    const now = new Date().toISOString();

    await Promise.all(
      repositories.map(async (repository) => {
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
  await databaseClient.close();
}
