create table clearance.review_users (
  id uuid primary key default extensions.gen_random_uuid(),
  github_login text not null,
  github_user_id bigint,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_users_github_login_unique unique (github_login),
  constraint review_users_github_user_id_unique unique (github_user_id)
);

create table clearance.review_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references clearance.review_users (id) on delete cascade,
  session_token_hash text not null,
  csrf_token_hash text not null,
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  constraint review_sessions_token_hash_unique unique (session_token_hash)
);

create index review_sessions_user_idx on clearance.review_sessions (user_id);
create index review_sessions_expires_idx on clearance.review_sessions (expires_at);

create table clearance.review_user_tokens (
  user_id uuid primary key references clearance.review_users (id) on delete cascade,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text,
  scopes jsonb not null default '[]'::jsonb,
  expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index review_user_tokens_expires_idx on clearance.review_user_tokens (expires_at);

create table clearance.review_patchsets (
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  patchset_number integer not null,
  head_sha text not null,
  base_sha text,
  parent_sha text,
  created_at timestamptz not null,
  actor text,
  event_type text not null check (
    event_type in ('opened', 'synchronize', 'force_push', 'base_update', 'reconstructed')
  ),
  force_push boolean not null default false,
  reconstructed boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  primary key (pull_request_id, patchset_number),
  constraint review_patchsets_pull_sha_unique unique (pull_request_id, head_sha)
);

create index review_patchsets_pull_created_idx on clearance.review_patchsets (
  pull_request_id,
  created_at
);

create table clearance.review_patchset_files (
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  patchset_number integer not null,
  file_path text not null,
  previous_file_path text,
  status text not null check (status in ('added', 'modified', 'deleted', 'renamed', 'unchanged')),
  additions integer not null default 0,
  deletions integer not null default 0,
  patch text,
  summary jsonb not null default '{}'::jsonb,
  primary key (pull_request_id, patchset_number, file_path)
);

create index review_patchset_files_path_idx on clearance.review_patchset_files (file_path);

create table clearance.review_threads (
  id uuid primary key default extensions.gen_random_uuid(),
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  github_thread_node_id text,
  github_first_comment_id bigint,
  marker text not null,
  owner_login text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  anchor_status text not null default 'current' check (
    anchor_status in ('current', 'moved', 'uncertain', 'deleted')
  ),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_threads_marker_unique unique (marker),
  constraint review_threads_github_thread_unique unique (github_thread_node_id)
);

create index review_threads_pull_status_idx on clearance.review_threads (pull_request_id, status);

create table clearance.review_thread_anchors (
  thread_id uuid primary key references clearance.review_threads (id) on delete cascade,
  original_patchset_number integer not null,
  current_patchset_number integer,
  original_path text not null,
  current_path text,
  original_line integer not null,
  current_line integer,
  side text not null,
  source_text text not null,
  token_context jsonb not null default '[]'::jsonb,
  confidence_basis_points integer not null default 10000
);

create index review_thread_anchors_current_path_idx on clearance.review_thread_anchors (
  current_path
);

create table clearance.review_thread_comments (
  id uuid primary key default extensions.gen_random_uuid(),
  thread_id uuid not null references clearance.review_threads (id) on delete cascade,
  github_comment_id bigint,
  github_node_id text,
  github_url text,
  marker text not null,
  author_login text not null,
  body text not null,
  mirrored_to_github boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz,
  constraint review_thread_comments_marker_unique unique (marker),
  constraint review_thread_comments_github_id_unique unique (github_comment_id)
);

create index review_thread_comments_thread_idx on clearance.review_thread_comments (thread_id);

create table clearance.review_marks (
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  user_login text not null,
  file_path text not null,
  patchset_number integer not null,
  marked_at timestamptz not null,
  primary key (pull_request_id, user_login, file_path)
);

create index review_marks_user_idx on clearance.review_marks (user_login);

create table clearance.review_visits (
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  user_login text not null,
  last_visited_at timestamptz not null,
  primary key (pull_request_id, user_login)
);

create index review_visits_user_idx on clearance.review_visits (user_login);

create table clearance.review_attention_members (
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  user_login text not null,
  reason text not null,
  added_by text,
  added_at timestamptz not null,
  primary key (pull_request_id, user_login)
);

create index review_attention_members_pull_idx on clearance.review_attention_members (
  pull_request_id
);

create table clearance.review_attention_events (
  id uuid primary key default extensions.gen_random_uuid(),
  pull_request_id uuid not null references clearance.pull_requests (id) on delete cascade,
  actor text not null,
  action text not null check (
    action in ('patchset-pushed', 'comment-left', 'thread-resolved', 'pass', 'not-my-turn')
  ),
  target_login text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);

create index review_attention_events_pull_created_idx on clearance.review_attention_events (
  pull_request_id,
  created_at
);
