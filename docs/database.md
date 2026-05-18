# Database

Clearance uses Supabase Postgres through Drizzle when `DATABASE_URL` is configured.

The database is the canonical persistence layer for:

- pull request Clearance state
- normalized requirements, assignments, approvals, notifications, and escalation events
- webhook delivery tracking
- durable GitHub side-effect outbox jobs

The sticky PR comment remains the user-facing GitHub status surface and compatibility fallback.

## Local Setup

Start Supabase locally:

```sh
supabase start
```

Reset the local database from migrations:

```sh
npm run db:reset
```

Use the local database URL in `.env`:

```sh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

## Migrations

Create migrations with the Supabase CLI:

```sh
supabase migration new migration_name
```

Drizzle schema lives in `src/db/schema.ts`. The checked-in SQL migrations under `supabase/migrations` are what Supabase applies.

Apply migrations to a linked Supabase project:

```sh
npm run db:push
```

## Connection Settings

For long-running hosts such as Fly or Cloudflare Containers, use a direct Supabase Postgres URL or Supavisor session mode. Keep:

```sh
DATABASE_PREPARE_STATEMENTS=false
```

This avoids prepared-statement issues if the connection later moves through a pooler.

## Outbox

When `DATABASE_URL` is configured, webhook and escalation workflows enqueue GitHub writes instead of performing them inline. The outbox currently handles:

- sticky comment upserts
- standalone escalation or fallback comments
- commit statuses
- reviewer requests
- notification comments

Drain queued jobs once:

```sh
npm run outbox
```

In production, schedule `npm run start:outbox` or run it as a small worker process. Tune each drain with:

```sh
OUTBOX_BATCH_SIZE=25
OUTBOX_MAX_ATTEMPTS=5
OUTBOX_POLL_INTERVAL_MS=0
```

The default `OUTBOX_POLL_INTERVAL_MS=0` drains once and exits, which fits scheduler-based hosting. Set a positive interval, for example `5000`, to keep the process alive and poll continuously.
