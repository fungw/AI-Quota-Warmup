# Test brief — quota-warmup worker

**One line:** take `worker/src/index.ts` from 0% to ~100% covered by fast,
deterministic tests that run in the real workerd runtime and never call the
Anthropic API.

## Why this is worth doing

The Worker's value is a *decision*, not an effect. Anyone can send a cron ping;
this thing exists to decide whether a ping would be wasted. That decision rests
on three things that are all awkward to observe in production:

1. **Wall-clock time in a DST-shifting zone.** `Europe/Dublin` moves twice a
   year. A bug in the offset arithmetic is silent for months and then fires an
   hour off.
2. **A persisted window boundary in KV.** Wrong state means either a wasted
   window — the exact failure this project was built to avoid — or a slot that
   is never served at all.
3. **A remote API's headers.** `anthropic-ratelimit-unified-5h-reset` is
   load-bearing. If it stops arriving, the code silently falls back to `+5h`
   and the schedule drifts.

The production feedback loop is poor by design: one meaningful event every ~5
hours, observable only through logs, and each live experiment costs a real
rate-limit window. Cheap to test offline, expensive to test live — that
asymmetry is the whole argument for pushing coverage high here.

## Scope

**In:** every branch in `worker/src/` — target/DST arithmetic, the gating truth
table, retry and backoff, header parsing, KV reads and writes, both handlers
(`scheduled`, `fetch`), and config parsing including malformed input.

**Out:** real network calls to `api.anthropic.com`; real Cloudflare deploys; the
values in `wrangler.toml` (configuration, not code); the `.wrangler/` local
state directory.

## Approach in three sentences

Split the single 508-line file into small modules with pure cores and injected
seams (`now`, `sleep`, `fetch`), so time and the network stop being global
facts. Run everything under Vitest with `@cloudflare/vitest-pool-workers`, which
executes tests *inside* workerd with a real KV namespace from Miniflare — so
`Intl`, `Response`, `crypto.randomUUID` and KV behave as they do in production
rather than as Node approximations. Mock outbound HTTP at the undici layer with
`fetchMock` from `cloudflare:test`, and enforce coverage thresholds in CI.

## What "done" looks like

- `npm test` runs green in well under a minute with no network access.
- `npm run test:coverage` reports **100% statements / branches / functions /
  lines**, and every deliberate exclusion carries an inline comment saying why.
- The 2026 DST transitions (29 Mar, 25 Oct) and the "yesterday's slot" rollover
  each have a named test.
- A CI job fails the build on a coverage regression.

## Cost and risk

Roughly **a day of work**, front-loaded. The refactor in Phase 1 is the only
part that touches production behaviour, and it is a pure move-and-export with
no logic changes. The main risk is precisely that — restructuring before tests
exist to protect it. Mitigation is in the plan: Phase 0 pins current behaviour
with a handful of characterization tests against the *unmodified* file, so the
refactor has something to answer to.

Full case matrix and phasing: [`TEST_PLAN.md`](TEST_PLAN.md).
