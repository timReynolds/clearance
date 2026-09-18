# Ownership rules

Use `OWNERS.toml` to turn your team's review expectations into explicit requirements: who should
approve, how many approvals a change needs, and when to ask for help.

## Start with one team

Create `OWNERS.toml` at your repository root, replacing the example team with your own:

```toml
[[rule]]
paths = ["**"]
require = [{ from = "@your-org/platform", count = 1 }]
```

Every matching change needs one approval from that team. Actors can also be individual GitHub
users, such as `@alice`. Clearance resolves identities, selects reviewers, and keeps the pending
requirements visible in its PR comment.

Rules are read from the **pull request head revision**, so edits to ownership rules in a PR affect
that PR's evaluation.

## Require the right combination of approvals

Use `require` when every listed group must approve. Use `require_any` when one of the listed groups
can satisfy the requirement. You can combine both in a rule:

```toml
[[rule]]
paths = ["auth/**"]
require = [{ from = "@your-org/platform", count = 2 }]
require_any = [
  { from = "@your-org/security", count = 1 },
  { from = "@your-org/compliance", count = 1 },
]
```

This requires two platform approvals and one approval from either security or compliance.
`count` is a positive integer and defaults to `1`.

For several independent alternatives, nest the groups:

```toml
[[rule]]
paths = ["**"]
require_any = [
  [
    { from = "@your-org/security", count = 1 },
    { from = "@your-org/compliance", count = 1 },
  ],
  [
    { from = "@your-org/platform", count = 1 },
    { from = "@your-org/ml-platform", count = 1 },
  ],
]
```

This requires one approval from security/compliance **and** one from platform/ml-platform.

## Let teams own their directories

Add an `OWNERS.toml` in a subdirectory to give that area more specific rules. Paths are relative to
the ownership file's directory: `paths = ["**"]` in `services/payments/OWNERS.toml` covers that
subtree.

Clearance walks upward from each changed file, applying child rules before parent rules. Parent
requirements still apply by default. To give a subtree its own policy, put this at the top of its
ownership file:

```toml
inherit = false

[[rule]]
paths = ["**"]
require = [{ from = "@your-org/payments", count = 1 }]
```

`inherit` defaults to `true`. A value of `false` stops the upward walk after that file.

## Preview before enforcing

Put `dry_run = true` at the top of an ownership file, before any table headers:

```toml
dry_run = true

[[rule]]
paths = ["**"]
require = [{ from = "@your-org/platform", count = 1 }]
```

Clearance writes its PR comment so you can inspect the requirements, but skips reviewer requests,
commit statuses, notification comments, and escalation side effects. If any ownership file visited
for the changed files enables dry-run, it applies to the **whole PR**.

Remove the setting or set it to `false` to enforce the policy. Once the App has emitted
`clearance/config` and `clearance/review`, make both required in GitHub's branch protection or
ruleset. Dry-run does not emit those statuses and should be evaluated before requiring them.

## Keep reviews moving

Configure follow-ups for requirements that remain pending:

```toml
[escalation]
warn_after = "4h"
escalate_after = "8h"
fallback_after = "24h"
fallback_team = "@your-org/platform-leads"
reset_on_push = true

[[rule]]
paths = ["**"]
require = [{ from = "@your-org/platform", count = 1 }]
```

The policy warns assigned reviewers, requests another eligible reviewer, and eventually notifies a
fallback team. `reset_on_push = true` resets pending timers after pushes. Durations are positive
whole numbers followed by `s`, `m`, `h`, `d`, or `w`, such as `30m` or `2d`.

The top-level policy supplies defaults within that ownership scope. A rule can set its own
`escalation` table, for example `escalation = { warn_after = "1h" }` inside `[[rule]]`.

Follow-ups run when the operator schedules the [escalation worker](deployment.md#workers); setting
a policy alone does not schedule it.

## Keep people informed without requiring approval

Use notification rules for teams or people who should know about a change:

```toml
[[notify]]
paths = ["api/**"]
teams = ["@your-org/developer-relations"]
users = ["@alice"]
```

Notifications do not add approval requirements.

## Allow an explicit override

Authorize a team to grant review clearance when an exception is needed:

```toml
[override]
teams = ["@your-org/repo-admins"]
```

A member of an authorized team can comment on the PR:

```text
@clearance override
```

The override remains active until an authorized team member revokes it:

```text
@clearance override revoke
```

An override does not bypass invalid ownership configuration.

## What happens after a push?

Clearance re-evaluates the rules and changed files on PR open, reopen, ready-for-review, and
synchronize events. Submitted approvals are recorded against the current head revision. On a
subsequent push, approvals for requirements covering changed files become stale; approvals for
unaffected requirements remain valid.

The updated PR comment explains the requirements. `clearance/config` reports validation errors,
and `clearance/review` stays pending while approvals are missing. A PR with no triggered
requirements passes the review status, provided evaluation has no hard errors.

For a complete configuration with escalation, notification, and override settings, see
[the example ownership file](../examples/OWNERS.toml).

[Review guide](review.md) · [Deployment](deployment.md)
