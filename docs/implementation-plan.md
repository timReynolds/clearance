# Clearance V1 Implementation Plan

## Summary

This document is the canonical build plan for Clearance V1. It turns the draft
technical specification into an implementation sequence for the current
TypeScript GitHub App scaffold.

The V1 build starts with `OWNERS.toml` validation and ends with status checks,
sticky PR comments, reviewer assignment, scoped approval tracking, break-glass
overrides, and escalation. The stack is fixed for V1: Node.js, TypeScript,
Octokit, Zod, TOML parsing, Vitest, Oxlint, and Prettier.

V1 remains stateless except for the hidden JSON state block stored in the sticky
Clearance PR comment. No database, queue, UI, merge queue integration,
AI-assisted assignment, cross-repository ownership, or non-GitHub VCS support is
included.

## Implementation Milestones

### 1. Config Model And Validation

Build the complete `OWNERS.toml` model in the `owners` module.

- Parse root-level `inherit`, `[escalation]`, `[[rule]]`, `[[notify]]`, and
  `[override]` blocks.
- Validate required fields, unknown keys, actor references, duration strings,
  path arrays, and positive approval counts.
- Return structured config errors with file path, schema path, message, severity,
  and best-effort line context.
- Treat quorum feasibility as a warning when `count` exceeds known team
  membership, not a hard parse error.
- Keep parsing independent from GitHub API validation so syntax tests remain
  pure unit tests.

Testable slice: parsing and validation tests cover valid examples, malformed
TOML, unknown keys, malformed actors, bad durations, missing paths, and bad
counts.

### 2. Repository File Discovery And Ownership Tree Loading

Add repository file loading around Octokit.

- Discover every `OWNERS.toml` at the PR head SHA.
- Load file contents from GitHub without checking out repository contents.
- Preserve each ownership file's repository path, directory, parsed config, and
  validation diagnostics.
- Detect path traversal or symlink-derived duplicate ownership locations where
  GitHub metadata makes that visible.

Testable slice: mocked GitHub API tests load multiple ownership files, propagate
file-level errors, and produce a deterministic ownership tree.

### 3. Rule Resolution For Changed Files

Create the `resolution` module.

- Accept changed PR file paths plus loaded ownership files.
- Walk from each changed file's directory upward to the repository root.
- Apply `inherit = false` by stopping parent collection at that ownership file.
- Evaluate rule and notification path globs relative to the owning
  `OWNERS.toml` directory.
- Return flat `AndRequirement`, `OrRequirement`, and notification records.
- Preserve child-before-parent precedence and append inherited parent rules after
  child rules.
- Deduplicate identical triggered requirements across files and rules by stable
  requirement identity.

Testable slice: unit tests cover inheritance, `inherit = false`, child rule
precedence, AND and OR requirements, deduplication, and notification matching.

### 4. GitHub Identity Resolution

Create a small `github` adapter layer around Octokit.

- Resolve `@user`, `@org/team`, notification teams, escalation fallback teams,
  and override teams.
- Fetch team membership and expose candidate reviewer identities.
- Surface missing users or teams as config validation diagnostics.
- Cache repeated identity lookups within a single webhook handling run.
- Keep all Octokit calls behind typed functions so the rest of the codebase can
  be tested with simple mocks.

Testable slice: mocked API tests cover found and missing users, found and missing
teams, empty teams, and membership count warnings.

### 5. Review Requirement State And Sticky PR Comment Storage

Create the `state` module and PR comment renderer.

- Maintain one sticky Clearance PR comment and update it in place.
- Store hidden JSON state inside the comment.
- Track requirement identities, assignments, approvals, approved head SHAs,
  warnings, escalations, fallback notifications, notifications sent, and override
  usage.
- Render human-readable review requirement tables above the hidden state block.
- Make hidden state parsing resilient to a missing, malformed, or manually edited
  comment by rebuilding state from current PR data where possible.

Testable slice: unit tests cover state serialization, state parsing, malformed
state fallback, and markdown rendering for pending and granted PRs.

### 6. Status Checks

Create the `checks` module.

- Set `clearance/config` to `success` when all loaded ownership files are valid.
- Set `clearance/config` to `failure` when any ownership file has validation
  errors.
- Set `clearance/review` to `pending` while required approvals are unsatisfied.
- Set `clearance/review` to `success` when all requirements are satisfied or a
  valid override label is present.
- Set `clearance/review` to `failure` for hard runtime errors that prevent
  reliable enforcement, such as required teams with no eligible members.
- Choose GitHub commit statuses or check runs during implementation based on the
  cleanest Octokit support, but keep the public check names exactly
  `clearance/config` and `clearance/review`.

Testable slice: mocked API tests assert the correct check state for valid config,
invalid config, pending reviews, satisfied reviews, overrides, and hard errors.

### 7. Reviewer Assignment

Create the `assignment` module.

- Rank eligible reviewers deterministically using blame coverage, review history,
  current review load, and round-robin fallback.
- Apply the V1 weights from the spec: 40% blame, 30% review history, 20% current
  load, and 10% round-robin fallback.
- Exclude the PR author and unavailable users before scoring.
- Select exactly `count` reviewers when enough candidates exist.
- If `count` exceeds eligible candidates, assign all eligible candidates and
  surface a warning in the sticky comment.
- For OR slots, initially assign from the group with the strongest aggregate
  signal; later escalation may consider the next group in the slot.

Testable slice: unit tests cover deterministic ranking, author exclusion,
unavailable exclusion, too-few-candidates warnings, and OR slot group choice.

### 8. Pull Request Review Tracking And Scoped Stale Approval Invalidation

Wire pull request and review webhooks into the requirement state model.

- On PR open, reopen, ready-for-review, and synchronize events, recompute config,
  requirements, reviewer assignments, sticky comment, and checks.
- On submitted review events, map the reviewer to matching requirements and
  record approvals against the current head SHA.
- On new pushes, compare approved SHAs against files relevant to each requirement.
- Retain approvals when newly pushed commits do not affect relevant files.
- Invalidate only approvals whose relevant files changed.
- Request reviewers for newly introduced requirements.

Testable slice: mocked integration tests cover PR opened, PR synchronized,
approval recording, scoped invalidation, retained approvals, and newly introduced
requirements.

### 9. Escalation Timer Runner

Create the `escalation` module and a commandable scheduled entrypoint.

- Evaluate open PRs with pending requirements against inherited or per-rule
  escalation policy.
- Respect `warn_after`, `escalate_after`, `fallback_after`, `fallback_team`, and
  `reset_on_push`.
- Produce GitHub actions to warn assigned reviewers, add another reviewer from
  the same group, or mention the fallback team.
- Append escalation events to the sticky comment state and visible log.
- Treat business-hours timezone handling as a later V1 milestone after core
  elapsed-time escalation works.

Testable slice: unit tests cover warning, escalation, fallback, duplicate-event
prevention, and `reset_on_push` timing behavior.

### 10. Break-Glass Override Handling

Implement override evaluation after config and identity validation.

- Detect the configured override label on the PR.
- Require the override actor to belong to one of the configured override teams.
- Set `clearance/review` to `success` when a valid override is active.
- Record override activation in the visible audit log and hidden state.
- Do not allow an override to bypass invalid `OWNERS.toml` configuration.

Testable slice: tests cover no override, missing label, unauthorized override,
authorized override, audit logging, and invalid-config precedence.

## Stable Internal Boundaries

The implementation should keep these module boundaries stable through V1:

- `owners`: parses and validates `OWNERS.toml`, returns structured diagnostics,
  and exposes typed config models.
- `resolution`: accepts changed files plus loaded ownership files and returns
  flat requirement and notification records.
- `github`: wraps Octokit calls for files, teams, users, PR comments, review
  requests, reviews, statuses or check runs, blame, and changed files.
- `state`: reads and writes the hidden JSON state block in the sticky PR comment.
- `checks`: sets `clearance/config` and `clearance/review`.
- `assignment`: ranks and selects individual reviewers.
- `escalation`: evaluates pending requirements and produces warning,
  reassignment, and fallback actions.

Keep GitHub API details out of domain modules. Domain modules should accept plain
typed inputs and return typed decisions so they can be unit tested without
network mocks.

## Test Plan

Every implementation PR must pass:

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run format`
- `npm run build`

Required unit coverage:

- Valid and invalid `OWNERS.toml` parsing.
- Unknown keys, malformed actors, bad durations, missing paths, and bad quorum
  values.
- Inheritance and `inherit = false`.
- Child rule precedence over parent rules.
- AND and OR requirement resolution.
- Requirement deduplication.
- Notification matching.
- Override label behavior.
- Sticky comment state read/write round trips.
- Scoped stale approval invalidation when relevant files change.
- Escalation timing decisions.

Required mocked integration coverage:

- Pull request opened and synchronized flows.
- Config validation failure setting `clearance/config` to failure.
- Pending review requirements setting `clearance/review` to pending.
- Satisfied requirements setting `clearance/review` to success.
- Reviewer request creation for selected individuals.
- Sticky comment creation and update without comment spam.

## Assumptions And Defaults

- `docs/implementation-plan.md` is the canonical V1 roadmap.
- V1 stores state only in the hidden JSON block inside the sticky PR comment.
- `clearance/config` and `clearance/review` keep those exact public names even if
  the underlying GitHub API implementation changes.
- Escalation initially runs as a commandable scheduled process in this codebase;
  deployment wiring is separate.
- Business-hours timezone behavior is added after core escalation behavior is
  proven.
- No external database, queue, UI, merge queue integration, AI assignment,
  cross-repository ownership, or non-GitHub VCS support is included in V1.
