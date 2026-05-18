# Testing

Clearance uses layered tests so core policy stays reusable and GitHub API behavior remains isolated at the edge.

## Commands

Run the full suite:

```sh
npm run typecheck
npm run lint
npm test
npm run format
npm run build
```

Run coverage:

```sh
npm test -- --coverage
```

## Test Layers

### Core unit tests

Core modules do not import Octokit. They accept plain data and return decisions.

Covered areas:

- `owners`: TOML parsing, ownership tree assembly, diagnostics.
- `resolution`: changed-file rule matching, inheritance, AND/OR requirements, notifications.
- `assignment`: deterministic reviewer scoring and warning behavior.
- `state`: hidden state parsing, rendering, review approvals, scoped invalidation.
- `db`: persistence boundary behavior is covered through workflow tests; use Supabase local database checks when changing migrations or Drizzle schema.
- `checks`: status decisions.
- `escalation`: timing decisions.
- `override`: break-glass authorization.

### GitHub adapter tests

GitHub edge modules use small typed Octokit surfaces and mocked REST responses.

Covered areas:

- tree/blob loading
- identity resolution
- PR changed files
- commit comparison
- reviewer requests
- commit statuses
- sticky PR comments

Adapter tests should include unhappy paths. Prefer returning structured diagnostics or result objects from project code rather than throwing for expected failures.

### Workflow tests

Workflow tests compose core modules with mocked edge dependencies.

Covered areas:

- PR opened/synchronized flows
- submitted review flow
- invalid config behavior
- scoped stale approval retention and invalidation
- escalation action application

### Webhook handler tests

`@octokit/webhooks` does not provide a separate test harness package, but the package itself exposes the right helpers for integration tests:

- `webhooks.receive(...)`: dispatches an event directly to registered handlers.
- `webhooks.sign(payload)`: signs a serialized payload using the configured secret.
- `webhooks.verifyAndReceive(...)`: verifies the signature and dispatches the event.

The handler tests use these helpers so the test path exercises the same dispatcher used in production. This is better than calling handler internals directly because it catches event naming, signature, and payload-shape assumptions.

Reference: [`@octokit/webhooks` README](https://github.com/octokit/webhooks.js#readme).

## Testing Guidelines

- Add pure unit tests first when behavior can be expressed without GitHub API calls.
- Keep Octokit calls behind typed adapter functions.
- Mock only the small adapter surface a test needs.
- Include one success case and one unhappy path for each new adapter or workflow branch.
- Prefer result values and diagnostics for expected operational failures.
- Reserve thrown errors for programmer errors, test helpers, or truly unexpected runtime failures.
- Keep sticky comment state round-trip tests whenever the state shape changes.
