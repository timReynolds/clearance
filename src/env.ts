import { z } from "zod";

const envSchema = z.object({
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_PRIVATE_KEY: z.string().min(1).transform(normalizePrivateKey),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
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
