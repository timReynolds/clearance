import { z } from "zod";

const envSchema = z.object({
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(5),
  DATABASE_PREPARE_STATEMENTS: z.string().default("false").transform(parseBoolean),
  DATABASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  ESCALATION_REPOSITORIES: z.string().default("").transform(parseRepositoryList),
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_CLIENT_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  GITHUB_CLIENT_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  GITHUB_PRIVATE_KEY: z.string().min(1).transform(normalizePrivateKey),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(0),
  PORT: z.coerce.number().int().positive().default(3000),
  REVIEW_CSRF_COOKIE_NAME: z.string().min(1).default("clearance_review_csrf"),
  REVIEW_OAUTH_STATE_COOKIE_NAME: z.string().min(1).default("clearance_review_oauth_state"),
  REVIEW_SESSION_COOKIE_NAME: z.string().min(1).default("clearance_review_session"),
  REVIEW_SESSION_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  REVIEW_TOKEN_ENCRYPTION_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  WEBHOOK_PATH: z.string().min(1).default("/api/github/webhooks"),
});

export type Env = z.infer<typeof envSchema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}

function normalizePrivateKey(value: string): string {
  return value.replaceAll("\\n", "\n");
}

function parseRepositoryList(
  value: string,
  context: z.RefinementCtx,
): Array<{
  owner: string;
  repo: string;
}> {
  if (value.trim() === "") {
    return [];
  }

  return value.split(",").map((entry) => {
    const [owner, repo, extra] = entry.trim().split("/");
    if (
      owner === undefined ||
      owner === "" ||
      repo === undefined ||
      repo === "" ||
      extra !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: `invalid repository "${entry}"; expected owner/repo`,
      });

      return {
        owner: "",
        repo: "",
      };
    }

    return { owner, repo };
  });
}

function parseBoolean(value: string, context: z.RefinementCtx): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }

  context.addIssue({
    code: "custom",
    message: `invalid boolean "${value}"; expected true or false`,
  });
  return false;
}
