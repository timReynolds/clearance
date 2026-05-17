import { describe, expect, it } from "vitest";

import { assignReviewers } from "../../src/assignment/index.js";

describe("assignReviewers", () => {
  it("ranks eligible reviewers deterministically using V1 weights", () => {
    const result = assignReviewers({
      author: "author",
      candidatesByActor: {
        "@org/platform": [
          {
            blameCoverage: 0.1,
            currentLoad: 0,
            login: "bob",
            reviewHistory: 0.1,
            roundRobinRank: 0,
          },
          {
            blameCoverage: 0.9,
            currentLoad: 2,
            login: "carol",
            reviewHistory: 0.8,
            roundRobinRank: 4,
          },
          {
            blameCoverage: 0.95,
            currentLoad: 2,
            login: "alice",
            reviewHistory: 0.8,
            roundRobinRank: 4,
          },
        ],
      },
      requirements: [
        {
          count: 2,
          from: "@org/platform",
          identity: "and:platform",
          type: "and",
        },
      ],
    });

    expect(result.warnings).toEqual([]);
    expect(result.assignments[0]?.reviewers).toEqual(["alice", "carol"]);
    expect(result.assignments[0]?.scores.map((score) => score.login)).toEqual(["alice", "carol"]);
    expect(result.assignments[0]?.scores[0]?.totalScore).toBeGreaterThan(
      result.assignments[0]?.scores[1]?.totalScore ?? 0,
    );
  });

  it("excludes the PR author and unavailable users", () => {
    const result = assignReviewers({
      author: "alice",
      candidatesByActor: {
        "@org/platform": [
          { blameCoverage: 1, login: "alice" },
          { blameCoverage: 1, login: "bob", unavailable: true },
          { blameCoverage: 0.2, login: "carol" },
        ],
      },
      requirements: [
        {
          count: 1,
          from: "@org/platform",
          identity: "and:platform",
          type: "and",
        },
      ],
    });

    expect(result.assignments[0]?.reviewers).toEqual(["carol"]);
  });

  it("assigns all eligible reviewers and emits a warning when too few candidates exist", () => {
    const result = assignReviewers({
      author: "author",
      candidatesByActor: {
        "@org/platform": [{ login: "alice" }],
      },
      requirements: [
        {
          count: 2,
          from: "@org/platform",
          identity: "and:platform",
          type: "and",
        },
      ],
    });

    expect(result.assignments[0]?.reviewers).toEqual(["alice"]);
    expect(result.warnings).toEqual([
      "Requirement and:platform requested 2 reviewers from @org/platform, but only 1 eligible reviewer was available",
    ]);
  });

  it("chooses the strongest reviewer group for OR requirements", () => {
    const result = assignReviewers({
      author: "author",
      candidatesByActor: {
        "@org/compliance": [
          {
            blameCoverage: 0.2,
            currentLoad: 3,
            login: "compliance-reviewer",
            reviewHistory: 0.2,
            roundRobinRank: 2,
          },
        ],
        "@org/security": [
          {
            blameCoverage: 0.9,
            currentLoad: 0,
            login: "security-reviewer",
            reviewHistory: 0.9,
            roundRobinRank: 0,
          },
        ],
      },
      requirements: [
        {
          identity: "or:security-compliance",
          options: [
            { count: 1, from: "@org/compliance" },
            { count: 1, from: "@org/security" },
          ],
          type: "or",
        },
      ],
    });

    expect(result.assignments[0]).toEqual(
      expect.objectContaining({
        actor: "@org/security",
        reviewers: ["security-reviewer"],
        type: "or",
      }),
    );
  });
});
