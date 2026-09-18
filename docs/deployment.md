# Deploy Clearance

Run Clearance for your team to automate ownership reviews and offer a shared review workspace.
A deployment needs a GitHub App, Supabase Postgres, the HTTP service, and an outbox worker that
delivers queued updates to GitHub. Schedule an escalation sweep if you enable review reminders.

Use Node.js 22 and npm, or the supplied [Dockerfile](../Dockerfile). For local development, see
[Development](development.md).

## GitHub App

Create a GitHub App under your organization or user settings. Configure:

| Setting                                                 | Value                                     |
| ------------------------------------------------------- | ----------------------------------------- |
| Webhook URL                                             | `https://YOUR_HOST/api/github/webhooks`   |
| Webhook secret                                          | The same value as `GITHUB_WEBHOOK_SECRET` |
| User authorization callback, if enabling review sign-in | `https://YOUR_HOST/auth/github/callback`  |

Grant these permissions:

| Permission           | Access     | Purpose                                                      |
| -------------------- | ---------- | ------------------------------------------------------------ |
| Contents             | Read       | Read ownership files and repository data.                    |
| Metadata             | Read       | Access repository metadata.                                  |
| Organization members | Read       | Resolve teams and authorize overrides.                       |
| Pull requests        | Read/write | Read changes, request reviewers, and perform review actions. |
| Issues               | Read/write | Maintain the PR comment and send notifications.              |
| Commit statuses      | Read/write | Publish `clearance/config` and `clearance/review`.           |

Subscribe to **Pull request**, **Pull request review**, **Pull request review comment**, and
**Issue comment** events. The handlers process PR opens, reopens, ready-for-review events, and
pushes; submitted reviews; Clearance-marked review comments; and override commands.

Generate a private key and install the App on the repositories you want Clearance to manage.
Add [ownership rules](configuration.md) to those repositories.

## Environment

Copy [.env.example](../.env.example) to `.env` for local use, or configure equivalent secrets and
environment variables on your host.

| Variable                                   | Purpose / default                                                  |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `GITHUB_APP_ID`                            | Required numeric App ID.                                           |
| `GITHUB_PRIVATE_KEY`                       | Required PEM private key; escaped `\n` sequences are supported.    |
| `GITHUB_WEBHOOK_SECRET`                    | Required webhook signing secret.                                   |
| `DATABASE_URL`                             | Required Postgres connection string, including for public preview. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Set both to enable GitHub sign-in for review actions.              |
| `REVIEW_SESSION_SECRET`                    | Session signing secret, at least 32 characters.                    |
| `REVIEW_TOKEN_ENCRYPTION_KEY`              | Token encryption secret, at least 32 characters.                   |
| `PORT`                                     | HTTP port; defaults to `3000`.                                     |
| `WEBHOOK_PATH`                             | Defaults to `/api/github/webhooks`.                                |
| `DATABASE_MAX_CONNECTIONS`                 | Connection limit per process; defaults to `5`.                     |
| `DATABASE_PREPARE_STATEMENTS`              | Defaults to `false`.                                               |
| `OUTBOX_BATCH_SIZE`                        | Jobs claimed per pass; defaults to `25`.                           |
| `OUTBOX_MAX_ATTEMPTS`                      | Attempt limit; defaults to `5`.                                    |
| `OUTBOX_POLL_INTERVAL_MS`                  | `0` runs one pass; a positive interval keeps the worker polling.   |

Set dedicated review secrets for a hosted instance. If omitted, the session secret falls back to
the webhook secret, and the encryption key falls back to the session secret or webhook secret.
Cookie-name overrides are listed in the environment template.

Review sign-in uses the GitHub App's client credentials and writes native review actions as the
signed-in user.

## Database

Install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
with `supabase` on your PATH. The repository already includes its Supabase project configuration.

For a hosted project, link it and apply the checked-in migrations:

```sh
supabase link --project-ref YOUR_PROJECT_REF
npm run db:push
```

Set `DATABASE_URL` using the project's connection details. For a long-running service, use a direct
connection or Supavisor session mode when the host needs IPv4. Keep prepared statements disabled
unless the connection path supports them. See Supabase's
[connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).

For local development with a Docker-compatible runtime:

```sh
supabase start
```

The default local connection is:

```sh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

To rebuild a disposable local database from migrations, use `npm run db:reset`. It deletes local
database data. Schema ownership and persistence behavior are described in [Development](development.md).

## Build and run

```sh
npm ci
npm run build
npm start
```

The HTTP process receives webhooks and serves the built workspace at
`https://YOUR_HOST/review/OWNER/REPO/pull/NUMBER`. `GET /healthz` reports that the HTTP service is
running; it does not verify database connectivity or GitHub delivery.

## Workers

Run the outbox in a separate process with the same App credentials and database configuration:

```sh
OUTBOX_POLL_INTERVAL_MS=5000 npm run start:outbox
```

The worker publishes PR comments, commit statuses, reviewer requests, and notifications. Without
it, accepted webhook changes remain queued. With the default interval of `0`, the command processes
one batch and exits; use repeated scheduled runs if you choose that mode.

For timed review reminders, schedule this command at your desired sweep interval:

```sh
npm run start:escalate
```

The sweep finds repositories already tracked in the database, checks their currently open PRs,
and queues warnings, additional reviewer requests, and fallback notifications. Keep the outbox
running to deliver them. Timing depends on your sweep and delivery intervals.

## Deploy with Fly

The supplied [fly.toml](../fly.toml) defines an `app` process for HTTP and an `outbox` process
polling every five seconds. It currently names the project instance `clearance-tr`; choose your own
Fly app name and update that setting for a separate deployment.

Before deploying, provision the database, apply migrations, and set these Fly secrets:

- `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`
- `DATABASE_URL`
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `REVIEW_SESSION_SECRET`, and
  `REVIEW_TOKEN_ENCRYPTION_KEY` if enabling review sign-in

After creating your Fly app and setting its secrets, deploy:

```sh
fly deploy --remote-only --ha=false --app YOUR_FLY_APP
```

Point the GitHub webhook and authorization callback URLs at your Fly hostname. The supplied Fly
configuration does not schedule escalation sweeps; add a scheduler if you want timed follow-ups.

## Verify the team workflow

1. Open a test PR that matches an `OWNERS.toml` rule.
2. Confirm GitHub delivered the webhook and the outbox worker processed the queued jobs.
3. Check that the PR has one Clearance comment and, outside dry-run, the two Clearance statuses.
4. Submit an eligible approval and confirm the requirement updates.
5. Open the PR in Clearance Review. If sign-in is enabled, verify a review action appears on GitHub.

Once the policy behaves as intended, require `clearance/config` and `clearance/review` in the
repository's branch protection or ruleset. Clearance publishes statuses; GitHub's repository
settings decide whether they block merging.

[Ownership rules](configuration.md) · [Review guide](review.md) · [Development](development.md)
