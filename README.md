# Clearance

[![CI](https://github.com/timReynolds/clearance/actions/workflows/ci.yml/badge.svg)](https://github.com/timReynolds/clearance/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Know who needs to review, what changed, and when a pull request is ready.**

Clearance brings ownership rules and a focused code review workspace to GitHub. It finds the
reviewers a change needs, keeps approvals current as code evolves, and shows what is still waiting
for attention. Your team keeps its pull requests, comments, and approvals on GitHub.

[Get started](docs/deployment.md) · [Review guide](docs/review.md) · [Contribute](CONTRIBUTING.md)

## Why use Clearance?

- **Make ownership actionable.** Describe who must approve each part of your repository, including
  approval counts and alternatives such as security **or** compliance. Clearance requests reviewers
  and tracks the requirements in one updated PR comment.
- **Keep the reviews that still count.** When a push changes files covered by one requirement,
  Clearance invalidates that requirement's approvals while retaining approvals for unaffected
  requirements. A documentation fix need not restart an unrelated backend review.
- **Pick up where you left off.** Compare recorded PR revisions, see which files need another look,
  and catch new comments since your last visit in the review workspace.
- **Make the next step visible.** See who needs to act, pass attention to a teammate, and configure
  reminders, additional reviewers, and fallback notifications for reviews that stall.
- **Keep working in GitHub.** Review comments, replies, approvals, and thread resolution from
  Clearance are written to GitHub as the signed-in reviewer. Teams can use the ownership checks
  without adopting the review workspace.

Clearance is particularly useful for shared repositories, monorepos, and changes that need sign-off
from several teams. It is self-hosted and [MIT licensed](LICENSE).

## Ownership that matches your team

Add an `OWNERS.toml` at the repository root. For example, require a platform reviewer for every
change, plus either security or compliance for changes under `auth/`:

```toml
[[rule]]
paths = ["**"]
require = [{ from = "@your-org/platform", count = 1 }]

[[rule]]
paths = ["auth/**"]
require_any = [
  { from = "@your-org/security", count = 1 },
  { from = "@your-org/compliance", count = 1 },
]
```

Use your own GitHub team names. Add ownership files in subdirectories as responsibility becomes
more specific; child rules inherit parent rules unless you explicitly stop inheritance.

On a pull request, Clearance resolves the changed files against these rules, requests reviewers,
and reports progress through a single PR comment and two commit statuses:

| Status             | What it tells you                                                      |
| ------------------ | ---------------------------------------------------------------------- |
| `clearance/config` | Ownership configuration and identities are valid.                      |
| `clearance/review` | Required approvals are satisfied, or an authorized override is active. |

Make both statuses required in your repository's branch protection or ruleset to gate merging.
Start with `dry_run = true` to preview requirements before enabling enforcement.

[Configure ownership →](docs/configuration.md)

## A workspace for the next review pass

Clearance Review puts the diff, discussions, ownership requirements, and next actions in one place.
Filter changed files, switch between split and unified diffs, leave comments on lines, and navigate
with keyboard shortcuts. Recorded revisions are numbered as **patchsets**, so you can compare one
review pass with another. File review marks show whether your previous pass is still current.

Open a pull request on your Clearance instance:

```text
https://YOUR_HOST/review/OWNER/REPO/pull/NUMBER
```

Public PRs can be previewed without installing the App on their repository. Recorded history,
review marks, and attention tracking need a PR indexed by the App; writing reviews needs GitHub
sign-in. See the [review guide](docs/review.md) for the full workflow.

## Get started

1. [Deploy Clearance](docs/deployment.md) with a GitHub App, Supabase Postgres, and the background
   worker. The repository includes a Docker image definition and Fly configuration.
2. Install your App on a repository and add [ownership rules](docs/configuration.md).
3. Open a PR, check its Clearance comment, and enable the required statuses when you are ready.
4. Enable GitHub sign-in to let reviewers work from [Clearance Review](docs/review.md).

## Documentation

- [Ownership rules](docs/configuration.md): approval policies, dry-run rollout, reminders, and overrides.
- [Review guide](docs/review.md): reviewing changes, tracking progress, and handing work back.
- [Deployment](docs/deployment.md): GitHub App setup, database, workers, and hosting.
- [Development](docs/development.md): local setup, tests, and the codebase.

## Contributing

Bug reports, documentation improvements, and pull requests are welcome. Start with the
[contribution guide](CONTRIBUTING.md) for local setup, checks, and how to submit a useful report.

## License

Clearance is available under the [MIT License](LICENSE).
