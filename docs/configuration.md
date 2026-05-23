# Configuration

Clearance reads `OWNERS.toml` files from the pull request head SHA. Put one file at the repository root and optionally add more files in subdirectories for narrower ownership rules.

Rules are evaluated from the changed file directory upward. Child ownership files run before parent ownership files. Set `inherit = false` to stop parent ownership rules from applying below a directory.

## Minimal File

```toml
[[rule]]
paths = ["**"]
require = [
  { from = "@org/platform-eng", count = 1 },
]
```

## Full Example

```toml
inherit = true
dry_run = true

[escalation]
warn_after = "4h"
escalate_after = "8h"
fallback_after = "24h"
fallback_team = "@org/platform-leads"
reset_on_push = true

[[rule]]
paths = ["**"]
require = [
  { from = "@org/platform-eng", count = 1 },
]
require_any = [
  { from = "@org/security-eng", count = 1 },
  { from = "@org/compliance", count = 1 },
]

[[notify]]
paths = ["**"]
teams = ["@org/compliance"]
users = ["@alice"]

[override]
teams = ["@org/repo-admins"]
```

## Fields

### `inherit`

Optional boolean. Defaults to `true`. When `false`, Clearance stops collecting parent ownership files once this file is reached.

### `dry_run`

Optional boolean. Defaults to `false`. When `true`, Clearance reports matching requirements in the sticky PR comment but does not request reviewers, set statuses, send notification comments, or run escalation side effects.

### `[escalation]`

Default escalation policy for rules in this ownership scope:

- `warn_after`: duration before warning assigned reviewers.
- `escalate_after`: duration before requesting another eligible reviewer.
- `fallback_after`: duration before notifying a fallback team.
- `fallback_team`: `@org/team` reference.
- `reset_on_push`: when true, pending timers reset after new pushes.

Durations use `s`, `m`, `h`, `d`, or `w`, for example `30m`, `4h`, or `2d`.

### `[[rule]]`

Approval requirements for matching files:

- `paths`: non-empty path glob array, relative to the `OWNERS.toml` directory.
- `require`: all listed actors must satisfy their counts.
- `require_any`: one listed actor group must satisfy its count.
- `escalation`: optional per-rule escalation override.

Actors can be users such as `@alice` or teams such as `@org/platform-eng`.

For multiple independent OR requirements in the same rule, use nested `require_any` groups:

```toml
[[rule]]
paths = ["**"]
require_any = [
  [
    { from = "@org/security-eng", count = 1 },
    { from = "@org/compliance", count = 1 },
  ],
  [
    { from = "@org/platform", count = 1 },
    { from = "@org/ml-platform", count = 1 },
  ],
]
```

This requires one approval from security/compliance and one approval from platform/ml-platform.

### `[[notify]]`

Notification targets for matching files:

- `paths`: non-empty path glob array, relative to the `OWNERS.toml` directory.
- `teams`: `@org/team` references.
- `users`: `@user` references.

### `[override]`

Break-glass override policy:

- `teams`: teams whose members may activate the override.

An authorized team member can activate an override by commenting `@clearance override` on the pull request. The override remains active until an authorized team member comments `@clearance override revoke`.

An override cannot bypass invalid `OWNERS.toml` configuration.

## Pull Request Behavior

On PR open, reopen, ready-for-review, or synchronize, Clearance:

1. Loads all `OWNERS.toml` files at the PR head SHA.
2. Validates configuration and GitHub identities.
3. Resolves changed files to review requirements.
4. Assigns reviewers.
5. Persists Clearance state in the database.
6. Writes or updates one sticky Clearance comment.
7. Sets `clearance/config` and `clearance/review` statuses.

When `dry_run = true` is set in an applicable `OWNERS.toml`, Clearance still writes the sticky comment but skips enforcement side effects.

On review submission, Clearance records approvals against the current head SHA. On synchronize, approvals are invalidated only when relevant files changed.
