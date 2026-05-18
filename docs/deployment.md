# Deployment

Clearance runs as a Node.js HTTP service behind a GitHub App webhook.

## 1. Create the GitHub App

In GitHub, create a new GitHub App under your organization or user settings.

Set the webhook URL to:

```text
https://YOUR_HOST/api/github/webhooks
```

Use the same webhook secret in GitHub and in `GITHUB_WEBHOOK_SECRET`.

## 2. Configure Permissions

Use the least permissions that cover the workflows Clearance performs:

- **Contents: read**: read `OWNERS.toml` files from the PR head SHA.
- **Metadata: read**: required by GitHub for all Apps.
- **Members: read**: resolve team members for reviewer candidates and override authorization.
- **Pull requests: read/write**: list changed files and request reviewers.
- **Issues: read/write**: create and update the sticky PR comment.
- **Commit statuses: read/write**: set `clearance/config` and `clearance/review`.

## 3. Subscribe to Webhook Events

Subscribe to:

- Pull request
- Pull request review

The server handles `opened`, `reopened`, `ready_for_review`, and `synchronize` pull request actions, plus submitted pull request reviews.

## 4. Install the App

Install the App on each repository where Clearance should enforce ownership rules.

Each repository should include at least one `OWNERS.toml`; see [Configuration](configuration.md).

## 5. Configure the Runtime

Set environment variables:

```sh
GITHUB_APP_ID=12345
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=change-me
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DATABASE_MAX_CONNECTIONS=5
DATABASE_PREPARE_STATEMENTS=false
OUTBOX_BATCH_SIZE=25
OUTBOX_MAX_ATTEMPTS=5
OUTBOX_POLL_INTERVAL_MS=0
PORT=3000
WEBHOOK_PATH=/api/github/webhooks
ESCALATION_REPOSITORIES=owner/repo,another-owner/another-repo
```

Private keys may contain escaped newlines. The app normalizes `\n` sequences at startup.

`DATABASE_URL` should point at your Supabase Postgres database. For a long-running host such as Fly or Cloudflare Containers, prefer a direct Supabase Postgres connection or Supavisor session mode. Leave `DATABASE_PREPARE_STATEMENTS=false` unless you know the connection path supports prepared statements.

If `DATABASE_URL` is not set, Clearance falls back to the original sticky-comment-only state storage.

## 6. Apply Database Migrations

Initialize local Supabase services when needed:

```sh
supabase start
```

Apply migrations to a linked Supabase project:

```sh
npm run db:push
```

For local development, reset the local database from migrations:

```sh
npm run db:reset
```

## 7. Build and Run

Install and build:

```sh
npm ci
npm run build
```

Run:

```sh
npm start
```

Run one escalation sweep:

```sh
npm run start:escalate
```

Run one outbox drain:

```sh
npm run start:outbox
```

For local development:

```sh
npm run dev
npm run escalate
npm run outbox
```

## 8. Deploy to Fly

This repository includes a `Dockerfile` and `fly.toml` for Fly Machines. The configured Fly app is:

```text
clearance-tr
```

The Fly deployment runs two process groups:

- `app`: the GitHub webhook HTTP server.
- `outbox`: the polling GitHub side-effect worker.

Set the GitHub App credentials before the first deploy:

```sh
fly secrets set \
  GITHUB_APP_ID=12345 \
  GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----" \
  GITHUB_WEBHOOK_SECRET=change-me \
  ESCALATION_REPOSITORIES=owner/repo \
  --app clearance-tr \
  --stage
```

Then deploy:

```sh
fly deploy --remote-only --ha=false --app clearance-tr
```

Set the GitHub App webhook URL to:

```text
https://clearance-tr.fly.dev/api/github/webhooks
```

## 9. Local Webhook Testing

Use a tunnel or webhook relay, then point the GitHub App webhook URL at the public URL plus `WEBHOOK_PATH`.

For example:

```text
https://example-tunnel.ngrok-free.app/api/github/webhooks
```

Open a pull request with a matching `OWNERS.toml` rule. Clearance should create or update one PR comment and set:

- `clearance/config`
- `clearance/review`

## Operational Notes

- Clearance stores state in Supabase Postgres when `DATABASE_URL` is configured and still renders the sticky PR comment for GitHub users.
- The hidden V1 JSON block in the sticky comment remains as a compatibility fallback.
- The current HTTP service handles PR and review webhook workflows.
- When `DATABASE_URL` is configured, GitHub write side effects are queued in `clearance.outbox_jobs`; schedule `npm run start:outbox` with your platform scheduler or set `OUTBOX_POLL_INTERVAL_MS` to run it as a polling worker process.
- Escalation runs as a commandable sweep over `ESCALATION_REPOSITORIES`; schedule `npm run start:escalate` with your platform scheduler.
