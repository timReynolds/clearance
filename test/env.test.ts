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
});
