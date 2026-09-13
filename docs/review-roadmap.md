# Clearance Review Roadmap

Clearance Review is a GitHub-native review UI inspired by Critique and Gerrit. It is not a
workflow migration. GitHub remains the system of record for pull requests, review threads,
approvals, reviewer requests, viewed files, checks, and branch protection. Clearance adds the
missing review model on top: patchsets, durable anchors, explicit attention, since-last-review
diffs, and patchset-aware file marks.

## Product Contract

- Reviewers can move between github.com and Clearance Review without losing state or context.
- Comments, replies, thread resolution, approvals, file-viewed state, reviewer requests, and checks
  must be written to GitHub first whenever GitHub has a native representation.
- Clearance stores only the data GitHub cannot represent well: content anchors, patchset numbering,
  since-last-review marks, attention overrides, cache/index data, and recovery markers.
- The local database is a materialized review index. For patchsets, comments, reviews, and thread
  status, recovery from GitHub APIs should be possible.
- AI remains passive context by default. It can summarize, find call sites, and identify test
  coverage, but it should not create unsolicited inline review comments.

## V1 Core Review Loop

- **Patchsets:** every observed PR head SHA is numbered as `PS N`. Historical patchsets are
  reconstructed from GitHub timeline events where available and marked `reconstructed` if GitHub
  lacks exact data.
- **Patchset comparison:** default comparison is the viewer's last reviewed patchset to latest.
  Force-pushed patchsets are visually distinct. Rebase-only updates should normalize to an empty
  content diff once the git object cache is wired in.
- **Durable comments:** comments use GitHub review threads plus a hidden Clearance marker. Clearance
  stores content-window anchors and re-locates them on later patchsets.
- **Review marks:** file marks are per-user and patchset-aware. Native GitHub viewed-file state is
  best-effort mirrored through GraphQL.
- **Attention:** one visible attention set per PR, with pass and not-my-turn actions.
- **UI:** dense reviewer workspace using `@pierre/diffs` and `@pierre/trees`, with keyboard-first
  navigation and no marketing landing screen.

## Public PR Preview

Clearance Review can open any public GitHub pull request through
`/review/:owner/:repo/pull/:number` even when the GitHub App is not installed. This mode reads PR
metadata, the current file diff, and existing review comments from public GitHub REST APIs.

Public preview is intentionally limited:

- Only the current PR diff is available. Historical patchsets, force-push detection, and
  rebase-normalized comparisons require app indexing or future timeline backfill.
- Review marks, since-last-visit state, and attention changes require the pull request to be
  indexed by the app-backed database.
- Commenting, replying, approving, and viewed-file mirroring require GitHub OAuth and the viewer's
  normal GitHub permissions.
- Existing public review comments can be displayed, but resolving imported threads requires
  indexed GraphQL review-thread ids.

## GitHub API Surfaces

- REST pull request APIs for files, reviews, review comments, replies, and approvals.
- GraphQL timeline items for force-push reconstruction, especially `HeadRefForcePushedEvent`.
- GraphQL review-thread mutations for resolving and unresolving threads.
- GraphQL viewed-file mutations for mirroring patchset-aware review marks to GitHub's native state.
- Commit statuses for branch protection. Existing `clearance/config` and `clearance/review` stay;
  V1 adds `clearance/review-files` after file marks are enforced.

## Deferred Work

- **Stack support:** detect GitHub native `gh stack`, Graphite, ghstack, and Sapling from PR base
  refs, stack metadata, and body fingerprints. Show a stack navigator and layer-scoped net diff.
- **Browser overlay:** optional later extension for teams that want the UI embedded in github.com.
  V1 remains a web app to keep installation and security simpler.
- **AI context:** repo-indexed summaries, call sites, tests, and risk prompts. Keep opt-in for
  generated review comments.
- **Offline recovery:** scheduled backfill job that re-indexes open PRs from GitHub timeline,
  reviews, comments, and current files.
- **Patchset cache:** local git object cache for exact content diffs, rebase normalization, and
  faster warm interactions.

## Current Implementation Slice

The current implementation adds:

- Review database tables for users/sessions, encrypted token placeholders, patchsets, patchset
  files, anchors, threads, comments, marks, visits, attention members, and attention events.
- Review API endpoints under `/api/review/:owner/:repo/pull/:number`.
- A React workspace at `/review/:owner/:repo/pull/:number`.
- Public PR preview for uninstalled public repositories via GitHub REST.
- GitHub OAuth sign-in for user-scoped review actions.
- GitHub-native comment, reply, approval, thread-resolution, and viewed-file helpers.
- One review action module owns native writes and subsequent index updates. If GitHub accepts an
  action but indexing fails, the response preserves native success and includes an index warning.
  Missing native thread references prevent local-only replies or resolution; viewed-file mirroring
  remains best effort after the patchset-aware mark is saved.
- Hidden thread/comment markers on mirrored review comments.
- Pull request webhook indexing for patchsets and per-file patch snapshots.
- Recovery of Clearance-marked GitHub review comments from review-comment webhooks.
- Line-targeted comment creation from the diff gutter, with source snippets captured for durable
  anchors.
- Content-token anchor relocation across new patchsets, with uncertain/deleted states.
- GitHub compare-backed patchset comparison controls for choosing `PS N` to `PS M` on indexed PRs,
  with indexed snapshots as a fallback when GitHub cannot compare the recorded SHAs.
- Since-last-visit comment activity on the review snapshot and UI, backed by per-user visit marks.

Next implementation step: backfill open PRs from GitHub timeline/review APIs so pre-install
patchsets and externally-created review threads are reconstructed into the Clearance index, then
layer in stack detection for Graphite, ghstack, Sapling, and GitHub native stacks.
