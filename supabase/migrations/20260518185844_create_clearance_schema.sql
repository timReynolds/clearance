create extension if not exists pgcrypto with schema extensions;

create schema if not exists clearance;

create table clearance.pull_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  owner text not null,
  repo text not null,
  pull_number integer not null,
  author text not null,
  head_sha text not null,
  labels jsonb not null default '[]'::jsonb,
  state jsonb not null,
  last_processed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pull_requests_owner_repo_number_unique unique (owner, repo, pull_number)
);

create index pull_requests_owner_repo_idx on clearance.pull_requests (owner, repo);
create index pull_requests_head_sha_idx on clearance.pull_requests (head_sha);

create table clearance.requirements (
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  identity text not null,
  label text not null,
  type text not null check (type in ('and', 'or')),
  status text not null check (status in ('approved', 'pending')),
  required_count integer not null,
  approved_by jsonb not null default '[]'::jsonb,
  approved_head_sha text,
  assigned_reviewers jsonb not null default '[]'::jsonb,
  eligible_reviewers jsonb not null default '[]'::jsonb,
  relevant_files jsonb not null default '[]'::jsonb,
  pending_since timestamptz,
  updated_at timestamptz,
  warn_after text,
  escalate_after text,
  fallback_after text,
  fallback_team text,
  reset_on_push boolean,
  primary key (pull_request_id, identity)
);

create index requirements_status_idx on clearance.requirements (status);
create index requirements_pending_since_idx on clearance.requirements (pending_since);

create table clearance.requirement_files (
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  requirement_identity text not null,
  file_path text not null,
  primary key (pull_request_id, requirement_identity, file_path)
);

create index requirement_files_path_idx on clearance.requirement_files (file_path);

create table clearance.assignments (
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  requirement_identity text not null,
  reviewers jsonb not null default '[]'::jsonb,
  assigned_at timestamptz not null,
  primary key (pull_request_id, requirement_identity)
);

create index assignments_reviewers_idx on clearance.assignments using gin (reviewers);

create table clearance.approvals (
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  requirement_identity text not null,
  reviewer text not null,
  head_sha text not null,
  approved_at timestamptz not null,
  primary key (pull_request_id, requirement_identity, reviewer)
);

create index approvals_reviewer_idx on clearance.approvals (reviewer);
create index approvals_head_sha_idx on clearance.approvals (head_sha);

create table clearance.notifications_sent (
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  identity text not null,
  primary key (pull_request_id, identity)
);

create table clearance.state_events (
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  event_index integer not null,
  type text not null,
  requirement_identity text,
  actor text,
  message text not null,
  at timestamptz not null,
  primary key (pull_request_id, event_index)
);

create index state_events_type_idx on clearance.state_events (type);
create index state_events_at_idx on clearance.state_events (at);

create table clearance.webhook_deliveries (
  delivery_id text primary key,
  event text not null,
  action text,
  status text not null,
  payload jsonb,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index webhook_deliveries_event_idx on clearance.webhook_deliveries (event);
create index webhook_deliveries_status_idx on clearance.webhook_deliveries (status);

create table clearance.outbox_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index outbox_jobs_available_idx on clearance.outbox_jobs (status, available_at);
create index outbox_jobs_type_idx on clearance.outbox_jobs (type);
