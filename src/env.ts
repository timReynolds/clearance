import { z } from "zod";

const envSchema = z.object({
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(5),
  DATABASE_PREPARE_STATEMENTS: z.string().default("false").transform(parseBoolean),
  DATABASE_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1)),
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_PRIVATE_KEY: z.string().min(1).transform(normalizePrivateKey),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(0),
  PORT: z.coerce.number().int().positive().default(3000),
  WEBHOOK_PATH: z.string().min(1).default("/api/github/webhooks"),
});

export type Env = z.infer<typeof envSchema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}

function normalizePrivateKey(value: string): string {
  return value.replaceAll("\\n", "\n");
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
