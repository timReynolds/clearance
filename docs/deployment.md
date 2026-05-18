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
PORT=3000
WEBHOOK_PATH=/api/github/webhooks
ESCALATION_REPOSITORIES=owner/repo,another-owner/another-repo
```

Private keys may contain escaped newlines. The app normalizes `\n` sequences at startup.

## 6. Build and Run

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

For local development:

```sh
npm run dev
npm run escalate
```

## 7. Local Webhook Testing

Use a tunnel or webhook relay, then point the GitHub App webhook URL at the public URL plus `WEBHOOK_PATH`.

For example:

```text
https://example-tunnel.ngrok-free.app/api/github/webhooks
```

Open a pull request with a matching `OWNERS.toml` rule. Clearance should create or update one PR comment and set:

- `clearance/config`
- `clearance/review`

## Operational Notes

- Clearance stores V1 state only in the hidden JSON block inside the sticky PR comment.
- The current HTTP service handles PR and review webhook workflows.
- Escalation runs as a commandable sweep over `ESCALATION_REPOSITORIES`; schedule `npm run start:escalate` with your platform scheduler.
- No database is required for the current runtime.
