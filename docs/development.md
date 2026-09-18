# Develop Clearance

Clearance separates review policy from GitHub integration so ownership rules can be tested without
network calls. The Node service handles webhooks and review APIs; the React workspace is built into
the same deployable application.

## Run locally

Use Node.js 22, matching CI and the Docker image, and npm. For a running instance, you also need a
GitHub App and Supabase Postgres; follow [Deployment](deployment.md) for credentials, permissions,
and database setup. Local Supabase requires the CLI and a Docker-compatible container runtime.

```sh
npm ci
cp .env.example .env
supabase start
```

The repository already includes `supabase/config.toml` and migrations. To rebuild a disposable local
database from those migrations, run `npm run db:reset`; this deletes local database data.

Fill in `.env`, then build the workspace and start the server:

```sh
npm run build:web
npm run dev
```

In another terminal, run the worker so queued comments, reviewer requests, and statuses reach GitHub:

```sh
OUTBOX_POLL_INTERVAL_MS=5000 npm run outbox
```

The default server is at `http://localhost:3000`; the workspace is at
`/review/OWNER/REPO/pull/NUMBER`. `npm run dev` watches server code. Re-run `npm run build:web` after
UI edits to update the assets served by the Node process. The browser tests launch Vite separately
with mocked APIs.

To exercise webhooks, expose the server through a tunnel or relay and set the App's webhook URL to
the public host plus `/api/github/webhooks`. Open a test PR and verify the comment and statuses after
the worker runs. Use `npm run escalate` to run an escalation sweep manually.

## Verify changes

Run the full local verification suite before committing:

```sh
npm run typecheck
npm run lint
npm test
npm run format
npm run build
```

For changes to the review UI:

```sh
npx playwright install chromium
npm run test:browser
```

Use `npm run test:watch` during development or `npm test -- --coverage` for coverage.
`npm run format` checks formatting; `npm run format:write` applies it. CI currently runs typecheck,
lint, and the Vitest suite.

## Where things live

| Area                                                             | Responsibility                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/owners`, `src/resolution`                                   | Parse ownership rules and resolve changed files into requirements.                   |
| `src/assignment`, `src/checks`, `src/escalation`, `src/override` | Choose reviewers, decide statuses, follow up, and authorize overrides.               |
| `src/state`                                                      | Track approvals, scoped invalidation, and the sticky comment state snapshot.         |
| `src/workflow`                                                   | Accept review state changes and their outgoing GitHub work together.                 |
| `src/github`                                                     | Adapt policy decisions and review operations to GitHub APIs and webhooks.            |
| `src/review`                                                     | Review actions, authentication, snapshots, patchsets, anchors, marks, and attention. |
| `src/db`, `supabase/migrations`                                  | Drizzle persistence and the SQL migrations applied to Postgres.                      |
| `web`                                                            | The React review workspace.                                                          |
| `test`, `browser-test`                                           | Policy, adapter, workflow, route, and browser tests.                                 |

## Shared terms

- **Review requirement:** an approval obligation derived from ownership rules for the changed files.
- **Review transition:** a change to a PR's Clearance state together with the comments, statuses,
  reviewer requests, and notifications that must follow it. Acceptance retains that work for
  execution; it does not mean GitHub has completed it.
- **Escalation:** a warning, additional reviewer request, or fallback notification triggered by a
  requirement remaining pending beyond its configured time.

## Persistence and delivery

Postgres stores canonical ownership state: requirements, assignments, approvals, notifications,
escalations, webhook deliveries, and outgoing jobs. The hidden state block in the sticky PR comment
mirrors that state for GitHub visibility.

A review transition accepts its state update and outgoing GitHub jobs atomically. Acceptance means
the work is retained for execution; the outbox worker completes the GitHub writes later. Transaction
failures propagate so the delivery or escalation remains retryable.

The review index holds patchsets, file snapshots, anchors, threads, marks, visits, attention,
encrypted OAuth tokens, and sessions. GitHub remains authoritative for native review actions.
Those user actions write to GitHub inline, then update the index; they do not use the installation
outbox. Viewed-file mirroring is best effort after saving the local mark.

For schema changes, keep `src/db/schema.ts` and the SQL migrations aligned. Create a migration with:

```sh
supabase migration new migration_name
```

Validate it against a local Supabase database before applying it to a hosted project using the
[deployment instructions](deployment.md#database).

## Test boundaries

- **Core tests** pass plain data to policy modules without Octokit: parsing, inheritance, AND/OR
  requirements, assignment, scoped approvals, checks, escalation, and overrides.
- **Adapter and workflow tests** use small typed GitHub mocks. Cover successful decisions and
  expected failures, including invalid configuration, native-write ordering, index failures,
  thread references, viewed-file mirroring, and routing/authentication checks.
- **Webhook tests** use `webhooks.receive`, `webhooks.sign`, and `webhooks.verifyAndReceive` to
  exercise the registered dispatcher and signatures.
- **Durability tests** use embedded Postgres (PGlite), inject constraint failures, and verify
  rollback and retry through persisted state and claimed jobs. They do not validate Supabase
  hosting, pooling, or concurrent workers. The fixture substitutes native `gen_random_uuid` for
  the migration's Supabase extension wrapper.
- **Browser tests** exercise the workspace against mocked review APIs. They verify UI behavior,
  not a live GitHub installation or OAuth round trip.

Keep policy functions independent of Octokit, mock the smallest adapter surface needed, and use
structured results for expected operational failures. Preserve snapshot round-trip tests when
changing the hidden comment state. Use a live test installation for changes to permissions, OAuth,
or end-to-end GitHub delivery.

See [Contributing](../CONTRIBUTING.md) for bug reports and pull request guidance.
