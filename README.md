# Clearance

Clearance is a GitHub App that enforces hierarchical `OWNERS.toml` review rules on pull requests.

It loads ownership files from the PR head SHA, resolves changed files to required reviewers, assigns reviewers, stores canonical state in Supabase Postgres, renders one sticky PR comment, sets `clearance/config` and `clearance/review` commit statuses, tracks scoped stale approvals, and supports break-glass override comment commands.

Clearance also includes the first slice of **Clearance Review**, a GitHub-native review workspace
inspired by Critique and Gerrit. It keeps GitHub as the source of truth while adding patchsets,
durable anchors, file review marks, and an explicit attention set. See
[Review Roadmap](docs/review-roadmap.md).

## User Docs

- [Configuration](docs/configuration.md): write `OWNERS.toml` files.
- [Database](docs/database.md): configure Supabase Postgres and migrations.
- [Deployment](docs/deployment.md): create and run the GitHub App.
- [Testing](docs/testing.md): test strategy and webhook test helpers.
- [Review Roadmap](docs/review-roadmap.md): GitHub-native review UI direction.

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
After `npm run build`, the review UI is served from `/review/OWNER/REPO/pull/NUMBER`.
For public GitHub pull requests, the review UI can render a read-mostly preview without the GitHub
App installed by fetching current PR data from public GitHub APIs.
`DATABASE_URL` is required at startup. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and the
review secrets in `.env` to enable GitHub sign-in and mirrored review actions.

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
- `src/review`: contains the GitHub-native review data model, API store, and review helpers.
- `src/workflow`: composes core modules with GitHub edge adapters.
- `web`: contains the Clearance Review React workspace.
- `src/db`: contains the Drizzle schema, Supabase/Postgres client, and persistence store.
