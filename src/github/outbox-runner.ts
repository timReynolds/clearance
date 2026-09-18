import { executeGithubOutboxJob, type GithubOutboxInstallationClientFactory } from "./outbox.js";
import type { OutboxJobRecord } from "../db/index.js";

export type GithubOutboxRunnerStore = {
  claimOutboxJobs(limit: number): Promise<OutboxJobRecord[]>;
  completeOutboxJob(id: string): Promise<void>;
  failOutboxJob(input: {
    availableAt?: string;
    error: string;
    id: string;
    terminal: boolean;
  }): Promise<void>;
};

export type GithubOutboxRunOptions = {
  baseRetryDelayMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  maxRetryDelayMs?: number;
};

export type GithubOutboxRunResult = {
  claimed: number;
  failed: number;
  succeeded: number;
  terminalFailures: number;
};

export async function runGithubOutboxOnce(
  installationClientFactory: GithubOutboxInstallationClientFactory,
  store: GithubOutboxRunnerStore,
  options: GithubOutboxRunOptions = {},
): Promise<GithubOutboxRunResult> {
  const jobs = await store.claimOutboxJobs(options.batchSize ?? 25);
  const results = await Promise.all(
    jobs.map(async (job) => processJob(job, installationClientFactory, store, options)),
  );

  return {
    claimed: jobs.length,
    failed: results.filter((result) => result === "retry").length,
    succeeded: results.filter((result) => result === "success").length,
    terminalFailures: results.filter((result) => result === "terminal").length,
  };
}

async function processJob(
  job: OutboxJobRecord,
  installationClientFactory: GithubOutboxInstallationClientFactory,
  store: GithubOutboxRunnerStore,
  options: GithubOutboxRunOptions,
): Promise<"retry" | "success" | "terminal"> {
  try {
    await executeGithubOutboxJob(job, installationClientFactory);
    await store.completeOutboxJob(job.id);
    return "success";
  } catch (error) {
    const maxAttempts = options.maxAttempts ?? 5;
    const terminal = job.attempts >= maxAttempts;
    await store.failOutboxJob({
      availableAt: terminal ? undefined : getNextAvailableAt(job.attempts, options),
      error: getErrorMessage(error, "unknown outbox job error"),
      id: job.id,
      terminal,
    });

    return terminal ? "terminal" : "retry";
  }
}

function getNextAvailableAt(attempts: number, options: GithubOutboxRunOptions): string {
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 30_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 15 * 60_000;
  const delayMs = Math.min(baseRetryDelayMs * 2 ** Math.max(0, attempts - 1), maxRetryDelayMs);

  return new Date(Date.now() + delayMs).toISOString();
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
