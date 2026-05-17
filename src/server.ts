import { createServer } from "node:http";

import { App } from "@octokit/app";
import { createNodeMiddleware } from "@octokit/webhooks";
import dotenv from "dotenv";

import { readEnv } from "./env.js";
import { registerGithubHandlers } from "./github/handlers.js";

dotenv.config();

const env = readEnv();

const app = new App({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  webhooks: {
    secret: env.GITHUB_WEBHOOK_SECRET,
  },
});

registerGithubHandlers(app.webhooks);

const server = createServer(
  createNodeMiddleware(app.webhooks, {
    path: env.WEBHOOK_PATH,
  }),
);

server.listen(env.PORT, () => {
  console.info(`Clearance listening on :${env.PORT}${env.WEBHOOK_PATH}`);
});
