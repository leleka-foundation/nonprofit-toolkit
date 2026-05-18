# MCP Server Improvements — Checklist

Companion to `PLAN.md`. Tick items as they land. Each workstream is a separate PR unless we decide otherwise.

## Workstream 1 — Disconnect fix

### Cloud Run configuration

- [ ] Enable session affinity on the `mcp-server` service (`gcloud run services update mcp-server --region us-central1 --session-affinity`).
- [ ] Set CPU always allocated (`--no-cpu-throttling`).
- [ ] Leave `min-instances` at 0 (scale-to-zero) to keep costs down.
- [ ] Confirm new config with `gcloud run services describe mcp-server --region us-central1` and capture the diff in PR description.
- [ ] Smoke-test: hit `/health` and a `tools/list` from the deployed URL.

### Token lifetime

- [ ] Change `TOKEN_LIFETIME_S` in `apps/mcp/src/auth/provider.ts` from 3600 to 28800 (8h) — or 86400 (24h) if user prefers.
- [ ] Update the unit tests that assert `expires_in` and installation expiry.
- [ ] Verify refresh-token flow still rotates correctly with the new lifetime.

### Resource-metadata discovery

- [ ] Reproduce the 404 on `GET /.well-known/oauth-protected-resource/mcp` locally.
- [ ] Route the sub-path probe to the canonical metadata handler, or document why the 404 is harmless.
- [ ] Add a regression test asserting both metadata endpoints return the expected JSON shape.

### Stateless transport

- [ ] RED: write a test that posts two `tools/list` requests without a `Mcp-Session-Id` header and asserts both succeed (will fail today because the SDK requires session init first).
- [ ] GREEN: switch `StreamableHTTPServerTransport` to stateless mode in `apps/mcp/src/main.ts` (omit `sessionIdGenerator`, drop the in-memory `transports` map, build a fresh transport per request).
- [ ] Confirm the `donations-schema` prompt still resolves via `prompts/get`.
- [ ] Confirm `tools/list` and `tools/call` for `query-bigquery` and `generate-letter` still work end-to-end.
- [ ] Remove now-dead session-lifecycle logging (`onsessioninitialized`, `onsessionclosed`).

### Observability

- [ ] Add structured logging on 401 paths so we can distinguish token-expired vs. unknown-installation vs. domain-mismatch.
- [ ] (Optional) Add a `clientId`/`userEmail` field to tool-call logs.

### Acceptance + deploy

- [ ] `bun typecheck` zero errors.
- [ ] `bun lint` zero errors, zero warnings.
- [ ] `bun test:run` all green.
- [ ] `bun test:coverage` 100% on all new/changed files in `apps/mcp/`.
- [ ] Cloud Build + deploy a new revision; verify the new annotations are present.
- [ ] Baseline disconnect count from `claude.ai` over a 30-minute idle window; re-measure after deploy; record both numbers in the PR.
- [ ] Open PR. Title: `mcp: stabilize sessions, longer token TTL, stateless transport`.

## Workstream 2 — Compliance access for non-engineers

### MCP tools

- [ ] RED: tests for `apps/mcp/src/tools/compliance-status.ts` covering OK, `not_onboarded`, and error paths (mock `getComplianceStatusProduction`).
- [ ] GREEN: implement `compliance-status` handler.
- [ ] Register `compliance-status` in `apps/mcp/src/main.ts` with Zod input schema and a clear `description`.
- [ ] Repeat RED → GREEN → register for `compliance-discover` (`runDiscoveryProduction`).
- [ ] Repeat RED → GREEN → register for `compliance-record-evidence` (`recordComplianceEvidenceProduction`); validate `sourceId` + `evidence` inputs strictly.
- [ ] Add an MCP prompt `compliance-overview` describing how to interpret findings and walk through `Action Required` items.

### Playwright in the deployed image

- [ ] Verify Playwright + Chromium actually launch inside the `mcp-server` container as built today (run `compliance-discover` against a Phase 2 source from the deployed revision).
- [ ] If broken: adjust the `apps/mcp/Dockerfile` (Chromium path / Playwright install) and bake a known-good revision. Add a deployed-image smoke test.
- [ ] If unfixable in MCP container: document fallback (Cloud Run Job + tool that triggers + polls) and adjust the PR scope.

### Slack commands

- [ ] Add `apps/slack-bot/src/slack/commands/compliance-status.ts` following `donor-letter.ts` pattern; acknowledge within 3s, post the markdown report.
- [ ] Add `compliance-discover.ts` similarly. Decide posting target per user answer (DM / channel / `#compliance`).
- [ ] Register both commands in the slack-bot manifest / wiring as appropriate.
- [ ] Tests for command handlers (mock the wiring functions, assert posted blocks).

### Teammate docs

- [ ] Write `docs/mcp-improvements/TEAM-SETUP.md` with:
  - Claude.ai connector setup (URL, Google sign-in, first prompts to try).
  - Cowork connector setup (pending user clarification on the mechanism).
  - Slack commands list.
- [ ] Link the doc from the project README under a new "Team access" section.

### Acceptance + deploy

- [ ] `bun typecheck` zero errors.
- [ ] `bun lint` zero errors, zero warnings.
- [ ] `bun test:run` all green.
- [ ] `bun test:coverage` 100% on all new/changed files.
- [ ] Cloud Build + deploy `mcp-server` and `slack-bot`.
- [ ] Manual smoke test from Claude.ai: list tools, run `compliance-status`, run `compliance-discover`, run `compliance-record-evidence` for one source. Capture screenshots for PR.
- [ ] Manual smoke test of Slack commands in a dev channel.
- [ ] Open PR. Title: `mcp+slack: expose compliance to non-engineer teammates`.

## Cross-PR hygiene

- [ ] Confirm `docs/mcp-improvements/PLAN.md` and `CHECKLIST.md` reflect any course corrections discovered during implementation. Update before requesting review.
- [ ] After both PRs merge, update `MEMORY.md` (auto-memory) to note that compliance tools are now reachable via MCP + Slack, so future skills don't assume "local only".
