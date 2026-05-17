# Clearance

Clearance is a GitHub App for hierarchical ownership rules, explicit AND/OR approval requirements, scoped stale review handling, smart reviewer assignment, escalation, and inline `OWNERS.toml` validation.

This repository is currently scaffolded as a TypeScript GitHub App. The first build step establishes the runtime, test harness, linting, CI, and an initial parser boundary for `OWNERS.toml`.

## Development

Requirements:

- Node.js 20 or newer
- npm 11 or newer
- GitHub App credentials for local webhook testing

Install dependencies:

```sh
npm install
```

Copy the environment template:

```sh
cp .env.example .env
```

Run the local webhook server:

```sh
npm run dev
```

The app listens on `PORT` and accepts GitHub webhook deliveries at `WEBHOOK_PATH`.

## Scripts

- `npm run build` compiles TypeScript into `dist/`
- `npm run typecheck` runs TypeScript without emitting files
- `npm run lint` runs Oxlint with TypeScript, import, Node, Vitest, Unicorn, and OXC rules
- `npm test` runs Vitest
- `npm run format` checks formatting

## Current Shape

- `src/server.ts` starts the GitHub webhook server
- `src/assignment/assignment.ts` ranks and selects reviewers from candidate signals
- `src/checks/checks.ts` decides the `clearance/config` and `clearance/review` check states
- `src/escalation/escalation.ts` evaluates pending requirements for warning, escalation, and fallback actions
- `src/github/handlers.ts` registers first webhook handlers
- `src/github/identity.ts` resolves GitHub users, teams, and reviewer candidates through Octokit
- `src/github/ownership-tree.ts` fetches repository trees and blobs through Octokit
- `src/owners/schema.ts` parses and validates the initial `OWNERS.toml` structure
- `src/owners/tree.ts` discovers and assembles loaded ownership trees without Octokit
- `src/override/override.ts` evaluates configured break-glass override labels
- `src/resolution/resolution.ts` resolves changed files into required approvals and notifications
- `src/state/review-tracking.ts` records review approvals and scoped stale invalidation
- `src/state/state.ts` serializes Clearance state and renders the sticky PR comment body
- `src/workflow/escalation.ts` applies due escalation actions and updates sticky state
- `src/workflow/pull-request.ts` composes ownership loading, resolution, assignment, state, comments, checks, and reviewer requests
- `examples/OWNERS.toml` mirrors the draft spec's example configuration

## Status Checks

The planned GitHub status checks are:

- `clearance/review`
- `clearance/config`

The first scaffold logs relevant pull request events only. Status creation, sticky PR comments, reviewer assignment, scoped approval tracking, and escalation are implementation milestones after the project foundation.
