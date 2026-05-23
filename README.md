# Clearance

Clearance is a GitHub App that enforces hierarchical `OWNERS.toml` review rules on pull requests.

It loads ownership files from the PR head SHA, resolves changed files to required reviewers, assigns reviewers, stores canonical state in Supabase Postgres, renders one sticky PR comment, sets `clearance/config` and `clearance/review` commit statuses, tracks scoped stale approvals, and supports break-glass override comment commands.

## User Docs

- [Configuration](docs/configuration.md): write `OWNERS.toml` files.
- [Database](docs/database.md): configure Supabase Postgres and migrations.
- [Deployment](docs/deployment.md): create and run the GitHub App.
- [Testing](docs/testing.md): test strategy and webhook test helpers.

## Quick Start

Install dependencies:

```sh
npm install
```

Copy the environment template:

```sh
cp .env.example .env
```

Start the webhook server:

```sh
npm run dev
```

The app listens on `PORT` and receives GitHub webhook deliveries at `WEBHOOK_PATH`.

## Required Checks

Run the full local verification suite before committing:

```sh
npm run typecheck
npm run lint
npm test
npm run format
npm run build
```

## Repository Shape

- `src/owners`: parses, validates, discovers, and assembles ownership config without GitHub API dependencies.
- `src/resolution`: resolves changed files into approval requirements and notifications.
- `src/assignment`: ranks and selects reviewers from candidate signals.
- `src/state`: serializes the hidden sticky comment state snapshot and tracks review approvals.
- `src/checks`: decides `clearance/config` and `clearance/review` statuses.
- `src/escalation`: evaluates pending requirements for warning, escalation, and fallback actions.
- `src/override`: evaluates break-glass override comment commands.
- `src/github`: contains Octokit-facing adapters and webhook handlers.
- `src/workflow`: composes core modules with GitHub edge adapters.
- `src/db`: contains the Drizzle schema, Supabase/Postgres client, and persistence store.
