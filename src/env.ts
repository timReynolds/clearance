import { z } from "zod";

const envSchema = z.object({
  ESCALATION_REPOSITORIES: z.string().default("").transform(parseRepositoryList),
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
