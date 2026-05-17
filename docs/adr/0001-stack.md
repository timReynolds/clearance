# ADR 0001: TypeScript GitHub App Scaffold

## Status

Accepted

## Context

Clearance is specified as a GitHub App that reacts to pull request events, reads repository contents, requests reviewers, posts sticky comments, and writes status checks. The implementation needs a well-typed runtime, a straightforward webhook entrypoint, and fast local tests for ownership rule resolution.

## Decision

Use Node.js with TypeScript, `@octokit/app` for GitHub App primitives, `@octokit/webhooks` for webhook delivery handling, Zod for runtime configuration and parsed TOML validation, Oxlint for fast TypeScript linting, and Vitest for unit tests.

## Consequences

- The first implementation can run as a small HTTP service and later be adapted to serverless or container deployment.
- GitHub API calls remain close to Octokit's generated types.
- `OWNERS.toml` validation has a strict schema boundary before rule resolution and assignment logic are added.
