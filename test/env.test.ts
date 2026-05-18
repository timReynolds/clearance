import { describe, expect, it } from "vitest";

import { readEnv } from "../src/env.js";

describe("readEnv", () => {
  it("parses escalation repositories", () => {
    expect(
      readEnv({
        ESCALATION_REPOSITORIES: "acme/clearance, another/repo ",
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY: "line1\\nline2",
        GITHUB_WEBHOOK_SECRET: "secret",
      }).ESCALATION_REPOSITORIES,
    ).toEqual([
      {
        owner: "acme",
        repo: "clearance",
      },
      {
        owner: "another",
        repo: "repo",
      },
    ]);
  });

  it("rejects malformed escalation repositories", () => {
    expect(() =>
      readEnv({
        ESCALATION_REPOSITORIES: "not-a-repo",
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY: "key",
        GITHUB_WEBHOOK_SECRET: "secret",
      }),
    ).toThrow(/invalid repository/);
  });

  it("parses database settings", () => {
    const env = readEnv({
      DATABASE_MAX_CONNECTIONS: "7",
      DATABASE_PREPARE_STATEMENTS: "true",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/postgres",
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "key",
      GITHUB_WEBHOOK_SECRET: "secret",
      OUTBOX_BATCH_SIZE: "11",
      OUTBOX_MAX_ATTEMPTS: "4",
      OUTBOX_POLL_INTERVAL_MS: "5000",
    });

    expect(env.DATABASE_MAX_CONNECTIONS).toBe(7);
    expect(env.DATABASE_PREPARE_STATEMENTS).toBe(true);
    expect(env.DATABASE_URL).toBe("postgresql://postgres:postgres@localhost:5432/postgres");
    expect(env.OUTBOX_BATCH_SIZE).toBe(11);
    expect(env.OUTBOX_MAX_ATTEMPTS).toBe(4);
    expect(env.OUTBOX_POLL_INTERVAL_MS).toBe(5000);
  });

  it("rejects malformed database booleans", () => {
    expect(() =>
      readEnv({
        DATABASE_PREPARE_STATEMENTS: "sometimes",
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY: "key",
        GITHUB_WEBHOOK_SECRET: "secret",
      }),
    ).toThrow(/invalid boolean/);
  });
});
