# MCP Server Improvements — Plan

Branch: `mcp/improvements-disconnects-and-compliance-distribution`

Two independent workstreams, can ship as separate PRs:

1. **Stabilize the deployed MCP server** so adding it as a Claude.ai/Cowork connector doesn't lead to frequent disconnects.
2. **Expose compliance tooling to non-engineer teammates** via the same MCP server, plus a Slack-command path.

The plan first explains what I found, then lists concrete tasks as a checklist (see `CHECKLIST.md`). Acceptance gates from `.claude/rules/*` apply: TDD, 100% coverage on new code, `bun typecheck`/`lint`/`test:run` all green, no `any`, no `as` (except documented JSONB), Zod on all external data.

---

## Workstream 1 — Disconnect fix

### What I found

The deployed Cloud Run service `mcp-server` (project `leleka-data-373104`, region `us-central1`) is configured:

- `maxScale: 3`, no `minScale` (scales to zero)
- `containerConcurrency: 80`
- CPU `1`, memory `1Gi`
- No `run.googleapis.com/sessionAffinity` annotation → **session affinity disabled**
- No `run.googleapis.com/cpu-throttling` annotation → **CPU only during request processing**
- Timeout 120s (caps SSE long-poll length)
- Latest revision: `mcp-server-00020-cm9`

Code-side facts:

- `apps/mcp/src/main.ts:68` keeps an in-memory `Map<sessionId, transport>`. Streamable HTTP sessions are not shared across instances.
- `apps/mcp/src/auth/provider.ts:30` defines `TOKEN_LIFETIME_S = 3600` (1 hour). Refresh tokens last 7 days (`INSTALLATION_TTL_MS`).
- `mcpAuthRouter` is mounted from the SDK without an explicit `serviceDocumentationUrl`; observed log shows a 404 on `GET /.well-known/oauth-protected-resource/mcp` (path-suffixed metadata per RFC 9728), which some clients probe.
- Logs from the last 48h show repeated `MCP session started` events from a single `Claude-User` client within seconds — every new request that lands on a different instance manufactures a new session.
- Logs show recurring 401 bursts on `/mcp` from both `Claude-User` and `python-httpx`, consistent with 1h token expiry + re-auth cycles.

### Likely root causes (in order of impact)

1. **In-memory sessions + no Cloud Run session affinity.** A client's followup requests get round-robined across instances. The wrong instance has no entry in its `transports` map, so it creates a new session. Some clients interpret the changed `mcp-session-id` as a disconnect.
2. **CPU throttled between requests.** Streamable HTTP can hold an SSE stream open; with CPU off between events, the upstream can drop the connection. Cloud Run's 120s request timeout is also a hard ceiling on any single SSE response.
3. **Short 1h access-token lifetime** amplifies #1: even with refresh working, hourly token rotations multiply the chance of a session-routing miss.
4. **Resource-metadata 404** on `/.well-known/oauth-protected-resource/mcp` may cause some clients to fall back to a less reliable discovery path.

### Approach (minimum + stateless session option)

Order matters: do the cheap infra changes first, then the code change.

1. **Cloud Run config (no code, immediate effect)**
   - Enable session affinity: `--session-affinity` on `gcloud run services update`.
   - Set CPU always allocated: `--no-cpu-throttling`.
   - Leave `minScale` at 0 (scale-to-zero) — keep costs down. Cold-start hits are tolerable.
   - Increase request timeout to the maximum useful for SSE (e.g. 3600s) if we keep SSE; with stateless mode, default 300s is fine.
   - Verify with `gcloud run services describe` and a probe.

2. **Token lifetime**
   - Change `TOKEN_LIFETIME_S` to `8 * 3600` (8h). Long enough for a workday, short enough that the refresh path is still exercised. Refresh-token lifetime stays 7d.
   - Update tests for the new constant.

3. **Resource-metadata discovery**
   - Investigate the path-suffix discovery probe (`/.well-known/oauth-protected-resource/mcp`) and either route it to the existing metadata handler or document why it's safe to 404.
   - Add a regression test that the metadata is fetchable at both the canonical path and at the sub-path probe.

4. **Stateless StreamableHTTPServerTransport** (the "+ stateless session option")
   - The MCP SDK's `StreamableHTTPServerTransport` supports a stateless mode (no `sessionIdGenerator`) where every request creates a fresh transport, the server returns no `Mcp-Session-Id` header, and clients don't need to pin to one instance.
   - Trade-off: prompts, resource subscriptions, server-initiated events are unavailable in stateless mode. We currently use one prompt (`donations-schema`) — the prompt is read-only and re-fetched on demand, so this is fine.
   - Switching to stateless removes the in-memory `Map` entirely and makes session affinity unnecessary. Affinity is still worth enabling as belt-and-suspenders.
   - Verify by ablation: confirm `tools/list`, `tools/call`, and `prompts/get` all still work for both `Claude-User` (claude.ai) and the local Claude Code client.

5. **Observability**
   - Add structured logs on 401 and on session creation that include `clientId` and `userEmail` so we can tell whether disconnects are token, session, or client-side issues.
   - Add a `/livez` and `/readyz` distinction if needed (currently only `/health`). Probably not needed; flag if Cloud Run startup probe is the issue.

### Verification

- Manual: connect Claude.ai to the deployed server, call `query-bigquery` repeatedly over a 30-minute window with idle gaps, count disconnects. Baseline first, then re-measure after deploy.
- Manual: leave the local `donations-local` MCP idle for >1h and observe whether token refresh succeeds without re-prompting the user.
- Unit tests for the new token lifetime + stateless transport plumbing.

### Out of scope

- Migrating session state to Firestore (the "full hardening" option). Stateless mode achieves the same robustness for our tool surface without that cost.
- Changing the OAuth flow itself.

---

## Workstream 2 — Compliance access for non-engineer teammates

### What I found

- Compliance code lives in `src/compliance/`. The agent entry points are `runOnboardingProduction`, `runDiscoveryProduction`, `getComplianceStatusProduction`, `recordComplianceEvidenceProduction` in `src/compliance/skills/*-wiring.ts`.
- The Claude Code skills under `.claude/skills/compliance-{onboard,discover,status}/` only run when an engineer is using Claude Code locally — they aren't visible to Claude.ai or Cowork.
- The deployed MCP server exposes `query-bigquery` and `generate-letter` only. Compliance is not reachable from Claude.ai/Cowork today.
- Slack bot (`apps/slack-bot`) already has one slash command (`/donor-letter`) wired up under `src/slack/commands/`. Adding compliance commands fits the existing pattern.
- Per the user's decisions: expose `compliance-status`, `compliance-discover`, `compliance-record-evidence` (NOT `compliance-onboard`); make them available via Claude.ai connector, Cowork connector, and a Slack command.

### Why onboarding is excluded

Onboarding requires interactive interview + writing secrets. It's a one-time setup that an admin should do via Claude Code or a CLI, not something a teammate triggers from chat. The plan keeps onboarding on the engineer-only surface.

### Approach

#### 2a. Add compliance MCP tools to `apps/mcp`

For each new tool, follow the existing `query-bigquery` / `generate-letter` pattern: a handler file under `apps/mcp/src/tools/`, registered in `main.ts`, with the same Zod-validated inputs / Result-shaped outputs that the wiring function already produces. Reuse the `*Production` functions verbatim — they already handle migration, auth to GCP, and Result-style errors.

- **`compliance-status`** — no input args (or optional `format: 'markdown' | 'json'`). Calls `getComplianceStatusProduction({ projectId: config.PROJECT_ID })`. Returns the markdown report from `formatComplianceStatusReport` plus structured findings.
- **`compliance-discover`** — no input args. Calls `runDiscoveryProduction({ projectId })`. Returns the markdown report from `formatDiscoveryReport` plus per-source outcomes. Long-running (up to ~2 min for the IRS BMF download path). The tool description must warn about runtime.
- **`compliance-record-evidence`** — inputs: `sourceId: string`, `evidence: Record<string, unknown>`, optional `observedAt: string`. Calls `recordComplianceEvidenceProduction(...)`. Validates the evidence body shape per-source on the server side.

Each tool must:

- Validate inputs with Zod (see `.claude/rules/external-data-validation.md`).
- Return `{ content: [...], isError?: true }` per MCP SDK contract.
- Surface `not_onboarded` as a clear human-readable error pointing the user back to onboarding.
- Have 100% unit-test coverage; mock the `*Production` functions, do not hit GCP.

#### 2b. Make Playwright available in the deployed image (only if needed for discover)

`compliance-discover` Phase 2/3 includes Playwright sources (CA AG, CA SOS, CDTFA, etc.). The current `apps/mcp/Dockerfile` already installs Chromium and excludes `playwright`/`playwright-core` from the bundle but does install them as deps. Verify Playwright runs in the deployed container; if not, fix paths or pin a known-good Chromium revision. Add a smoke test invoking one Playwright source from a deployed-image test.

If Playwright is unworkable in the MCP container, fall back to running discover via a separate Cloud Run Job and have the MCP tool kick it off + poll — but only if needed. Document the decision in the PR description.

#### 2c. Slack slash commands

Add `apps/slack-bot/src/slack/commands/compliance-status.ts` and `compliance-discover.ts` following the existing `donor-letter.ts` pattern. Each:

- Acknowledges the command immediately (Slack's 3s rule).
- Calls the same wiring functions.
- Posts the markdown report back into the channel/thread.
- Authorizes only authenticated workspace users (existing slack-bot middleware).

Skip `compliance-record-evidence` from Slack for now (evidence entry is multi-field; better as a guided chat in Claude.ai). Note in PR description.

#### 2d. Teammate documentation

A short README (`docs/mcp-improvements/TEAM-SETUP.md`) telling a non-engineer teammate exactly how to:

1. Open Claude.ai / Cowork.
2. Add the connector: paste the deployed MCP URL.
3. Sign in with their `@leleka.care` Google account.
4. Try `Show me our compliance status` as the first prompt.

Plus Slack: which channel(s) the bot is in, the two slash commands.

#### 2e. Update the MCP `donations-schema` prompt or add a `compliance-onboard` prompt

The existing prompt `donations-schema` only describes the donations table. Add a second MCP prompt `compliance-overview` that gives the host LLM the same orientation the engineer-side skill provides: what sources exist, how to interpret findings, how to walk a user through `Action Required` items. Keep it short; defer details to per-tool descriptions.

### Verification

- Unit tests for each new MCP tool handler (mocked production functions, full coverage).
- Integration test that the MCP server lists the three new tools and that a `tools/call` for `compliance-status` returns the expected markdown for a known stored state.
- Manual smoke test from Claude.ai: connect, run `compliance-status`, run `compliance-discover`, run `compliance-record-evidence` for one CDTFA source.
- Manual smoke test of Slack commands in a dev channel.

### Out of scope

- Exposing `compliance-onboard` to Claude.ai/Cowork.
- A multi-tenant model (current code is single-tenant per `docs/compliance/PLAN.md`).
- Building a web UI; chat is the UI.

---

## Sequencing

Two PRs is cleanest:

- **PR 1 (Workstream 1):** disconnect stabilization. Small, infra-heavy. Ship and observe for a few days before piling more tools onto the server.
- **PR 2 (Workstream 2):** compliance tools + Slack commands + team docs.

If you'd rather collapse into one PR, fine — the workstreams don't touch the same files except both add code under `apps/mcp/`. I'll note this in the checklist.

## Open questions for the user

1. **Cowork connector mechanism.** I'm assuming Cowork uses the same MCP connector model as Claude.ai (paste URL, Google OAuth). If Cowork requires a different distribution channel (org-level connector approval, marketplace listing, etc.), I need to know before writing the teammate docs.
2. **Token lifetime.** 8h is a workday; 24h covers overnight. Preference?
3. **Slack `/compliance-discover` policy.** This command can run for ~2 min and post a long report. Should it post into the channel where invoked, DM the invoker, or always post into a dedicated `#compliance` channel?
