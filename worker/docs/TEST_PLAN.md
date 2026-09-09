# Test plan — quota-warmup worker

Companion to [`TEST_BRIEF.md`](TEST_BRIEF.md). That document argues *why*; this
one is the implementation plan: tooling, refactor, phasing, and the full case
matrix to write against.

Target: **100% statements / branches / functions / lines** over `worker/src/`,
with every exclusion justified inline.

---

## 1. Tooling

| Choice | Version | Why |
|---|---|---|
| `vitest` | **`~4.1.11`** | Not 5.x — see note below. |
| `@cloudflare/vitest-pool-workers` | `^0.22.0` | Runs each test *inside* workerd. |
| `@vitest/coverage-istanbul` | `^4.1.0` | v8 coverage does not work in the workers pool. |
| `wrangler` | `^4.0.0` (already present) | Miniflare comes bundled with the pool. |

> **Version pin, verified:** `@cloudflare/vitest-pool-workers@0.22.0` declares
> `peerDependencies: { vitest: "^4.1.0" }`. The latest published Vitest is
> `5.0.0`, which is **outside that range**. Install `vitest@~4.1.11` explicitly
> or npm will resolve 5.x and the pool will fail to load.

### Why the workers pool rather than plain Vitest + Node

Three things this Worker depends on behave differently, or not at all, under a
Node-based test runner:

- **`Intl.DateTimeFormat` with `formatToParts` and `hourCycle: "h23"`** — the
  entire DST story. Node has full ICU these days, but workerd is the runtime
  that actually ships, and the timezone database version is the thing under
  test. Testing the arithmetic anywhere else tests a different program.
- **KV** — the pool gives a real Miniflare-backed `KVNamespace` via
  `env.WARMUP_STATE`, including its JSON serialisation and `get<T>(key, "json")`
  semantics, instead of a hand-written fake that agrees with whatever the test
  author assumed.
- **`ScheduledController` / `ExecutionContext`** — `SELF.scheduled()` and
  `createExecutionContext()` / `waitUntil()` are provided, so the `scheduled`
  handler is exercised as the platform calls it rather than by reaching past it.

The cost is that the pool is slower to boot than a Node pool, and `vi.mock` of
ES modules is limited. Both are acceptable here; the second is handled by the
dependency-injection seams below rather than by module mocking.

### Outbound HTTP

`fetchMock` from `cloudflare:test` (undici's `MockAgent`) intercepts calls to
`https://api.anthropic.com`. Setup file:

```ts
// test/setup.ts
import { fetchMock } from "cloudflare:test";
import { beforeAll, afterEach } from "vitest";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();   // any unmocked call is a test failure
});
afterEach(() => fetchMock.assertNoPendingInterceptors());
```

`disableNetConnect()` is the load-bearing line: it guarantees the suite can
never spend a real rate-limit window.

---

## 2. Refactor for testability

The current file is one module with **no exports** except the default handler
object. Every pure function — `parseTargets`, `zonedTimeToUtc`, `currentTarget`,
`resetFromHeaders`, `isRetryable`, `pickHeaders`, `truncate` — is unreachable
from a test. Reaching 100% through `SELF.fetch()` alone would mean constructing
elaborate end-to-end scenarios to hit a `Number.isFinite` branch. That is the
wrong shape of test and it will not get there.

Proposed split (a pure move-and-export; **no logic changes**):

```
src/
  index.ts       # scheduled + fetch handlers only
  tick.ts        # tick(), the gating decision
  schedule.ts    # zonedYMD, zonedTimeToUtc, currentTarget
  config.ts      # Env, constants, parseTargets, resolveConfig
  anthropic.ts   # pickHeaders, truncate, isRetryable, resetFromHeaders,
                 # attemptWarmup, ping
  state.ts       # State, EMPTY_STATE, readState, writeState
  log.ts         # emit, fingerprint
```

### Three injected seams

Determinism needs exactly three things to stop being global facts. Add them as
optional parameters with production defaults, so no call site changes:

| Seam | Where | Default | Buys us |
|---|---|---|---|
| `now: () => Date` | `tick`, `currentTarget` | `() => new Date()` | Every clock case without `vi.setSystemTime` fighting workerd. |
| `sleep: (ms) => Promise<void>` | `ping` | real `setTimeout` | Retry tests that finish instantly instead of waiting 3s of real backoff. |
| `fetchImpl: typeof fetch` | `attemptWarmup` | `globalThis.fetch` | The thrown-non-`Error` and abort/timeout branches, which `fetchMock` cannot produce. |

Without the `sleep` seam the retry suite alone costs ~3 seconds of wall clock
per exhaustion test. Without the `fetchImpl` seam, three `catch` branches are
simply unreachable and 100% is off the table.

---

## 3. Phases

### Phase 0 — characterization net (before touching src) — ~1h

Write ~8 tests against the **unmodified** `index.ts` through `SELF.fetch()` and
`SELF.scheduled()`, pinning observable behaviour: `/health` JSON shape, the
404/403/401 responses, one skip path, one success path with a mocked API. These
exist solely so the Phase 1 refactor has something to answer to. They stay in
the suite afterwards as the integration layer.

Deliverable: `test/characterization.test.ts` green against current `main`.

### Phase 1 — refactor + scaffolding — ~2h

Apply the module split and the three seams. Add `vitest.config.ts`,
`test/setup.ts`, `test/env.d.ts`, and the npm scripts. Phase 0 tests must stay
green with zero edits to their assertions — that is the acceptance criterion for
the refactor.

```ts
// vitest.config.ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: { kvNamespaces: ["WARMUP_STATE"] },
      },
    },
    coverage: {
      provider: "istanbul",          // v8 is unsupported in this pool
      include: ["src/**/*.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
```

Scripts: `"test": "vitest run"`, `"test:watch": "vitest"`,
`"test:coverage": "vitest run --coverage"`.

### Phase 2 — pure units — ~2h

`config.test.ts`, `schedule.test.ts`, `anthropic.test.ts` (pure half). This is
where most of the branch count lives and where coverage moves fastest. Section 4
tables A–C.

### Phase 3 — I/O units — ~2h

`anthropic.test.ts` (network half), `state.test.ts`, `tick.test.ts`. Tables D–F.

### Phase 4 — handlers + close the gaps — ~1h

`index.test.ts` (table G), then run coverage and write targeted tests for
whatever is still uncovered. Add `/* istanbul ignore next -- reason */` only
where a branch is genuinely unreachable, always with a written reason.

### Phase 5 — CI — ~30m

GitHub Actions on push and PR: `npm ci`, `npm run typecheck`, `npm run
test:coverage`. Coverage thresholds fail the build. No secrets needed — the
suite makes no real network calls, which is worth stating in the workflow file
so nobody later "fixes" it by adding a token.

---

## 4. Case matrix

~95 cases. Counts are the minimum to close the branches, not a ceiling.

### A. `config.ts` — 15 cases

| # | Case | Expect |
|---|---|---|
| A1 | `TARGETS_LOCAL` unset | default `06:00,11:00,16:00,21:00` |
| A2 | `"06:00,11:00"` | two targets |
| A3 | `" 06:00 , 11:00 "` | whitespace trimmed |
| A4 | `"06:00,,11:00"` | empty segment skipped, 2 targets |
| A5 | `"6"` (no colon) | `{hours:6, minutes:0}` via the `m = "0"` default |
| A6 | `"21:00,06:00"` | sorted ascending — 06:00 first |
| A7 | `"abc"` | throws `Invalid entry "abc" in TARGETS_LOCAL` |
| A8 | `"06:xx"` | throws (minutes NaN) |
| A9 | `""` | throws `TARGETS_LOCAL is empty` |
| A10 | `","` | throws `TARGETS_LOCAL is empty` |
| A11 | `CATCHUP_HORIZON_MINUTES` unset | 240 min |
| A12 | `"60"` | 60 min |
| A13 | **`""`** | `??` does not catch empty string → `Number("")` = **0**. Pin it; see Finding 1. |
| A14 | **`"abc"`** | → `NaN` horizon → `currentTarget` always null → **never pings**. Pin it; see Finding 1. |
| A15 | `VERBOSE` unset / `"false"` / `"true"` / `"0"` | verbose except for the literal `"false"` |

### B. `schedule.ts` — 18 cases

Fixed instants, no `Date.now()` anywhere.

| # | Case | Expect |
|---|---|---|
| B1 | `zonedYMD` mid-day, Europe/Dublin | that day |
| B2 | `zonedYMD` at `2026-01-01T00:30Z` in `America/New_York` | **31 Dec** — proves it is not reading UTC |
| B3 | `zonedTimeToUtc` 06:00 on 15 Jan (GMT) | `06:00Z` |
| B4 | `zonedTimeToUtc` 06:00 on 15 Jul (IST, UTC+1) | `05:00Z` |
| B5 | **29 Mar 2026** — spring forward, target 01:30 (nonexistent local time) | pin whatever the round-trip produces, with a comment |
| B6 | **25 Oct 2026** — fall back, target 01:30 (ambiguous) | pin the chosen offset |
| B7 | Day before / day after each transition | offsets 0 and +1 as expected |
| B8 | `currentTarget` exactly at a target | returns it (`at <= now`) |
| B9 | 1 ms before a target | that target not chosen |
| B10 | `now = target + horizon` exactly | returns it (`<= horizonMs`) |
| B11 | `now = target + horizon + 1 ms` | `null` |
| B12 | Two past targets today | the **later** one |
| B13 | 00:30 local, prior 21:00 slot, horizon 240 | yesterday's 21:00 |
| B14 | 1 Mar 00:30 | 28/29 Feb 21:00 — month rollover |
| B15 | 1 Jan 00:30 | 31 Dec 21:00 — year rollover |
| B16 | 1 Mar 2028 (leap year) | 29 Feb 21:00 |
| B17 | 03:00 local, default targets, horizon 240 | `null` — the overnight gap |
| B18 | Single-target config `"06:00"` | works; no reliance on multiple slots |

### C. `anthropic.ts` pure helpers — 20 cases

| # | Case | Expect |
|---|---|---|
| C1–C4 | `pickHeaders`: keeps `anthropic-ratelimit-*`, `request-id`, `retry-after`; drops `content-type`; empty headers → `{}` | filtered map |
| C5–C8 | `truncate`: shorter than max; exactly max; longer (assert the `… (N chars total)` suffix); custom max | |
| C9–C16 | `isRetryable`: `undefined`→true, 408→true, 429→true, 500→true, 503→true, 400→false, 401→false, 404→false | |
| C17 | `resetFromHeaders` valid `"1800000000"` | `at = ×1000`, `source: "header"` |
| C18 | header absent | `now + 5h`, `source: "fallback:+5h"` |
| C19 | `"abc"` → NaN, `"0"`, `"-5"`, `""` | all fall back |
| C20 | fractional seconds `"1800000000.5"` | `source: "header"`, sub-ms retained |

### D. `attemptWarmup` / `ping` — 15 cases

| # | Case | Expect |
|---|---|---|
| D1 | 200 with a `text` block | `ok`, reply text, `usage` captured |
| D2 | 200, content has only non-text blocks | `"(no text block)"` |
| D3 | 200, `content` undefined | `"(no text block)"` |
| D4 | **Request shape** | URL, `POST`, `Authorization: Bearer …`, `anthropic-version: 2023-06-01`, `anthropic-beta` both flags, body `model` / `max_tokens: 64` / `messages` |
| D5 | `WARMUP_MESSAGE` set | overrides the default text |
| D6 | `WARMUP_MESSAGE` empty string | falls back to default (`||`, not `??`) |
| D7 | 400 | one attempt only — not retried |
| D8 | 429 with `retry-after: 2` | backoff **2000 ms**, succeeds on attempt 2 |
| D9 | 429 with no `retry-after` | exponential 1000 then 2000 |
| D10 | **429 with `retry-after: 3600`** | pin: sleeps an hour, uncapped. See Finding 3. |
| D11 | 500 × 3 | exhausts `MAX_ATTEMPTS`, error from `errorBody` |
| D12 | Long (>1000 char) error body | truncated in the log |
| D13 | `fetchImpl` throws an `Error` | `error.name` / `.message` captured |
| D14 | `fetchImpl` throws a **string** | `String(err)` branch |
| D15 | `verbose: false` | no `attempt.start` / `attempt.ok` lines; failures still logged |

### E. `state.ts` — 5 cases

| # | Case | Expect |
|---|---|---|
| E1 | Key absent | `EMPTY_STATE` |
| E2 | Partial stored JSON `{ nextResetAt: 1 }` | merged over `EMPTY_STATE`, other fields null |
| E3 | Full stored state | round-trips |
| E4 | Stored `null` | `EMPTY_STATE` (the `?? {}` branch) |
| E5 | Write then read via the real KV binding | identical object |

### F. `tick.ts` — the gating truth table — 16 cases

| # | force | target | firedTarget | nextResetAt | Expect |
|---|---|---|---|---|---|
| F1 | no | none | — | — | `skipped: no-target`, **and KV never read** |
| F2 | no | yes | matches | — | `skipped: already-served` |
| F3 | no | yes | differs | future | `skipped: window-still-open` |
| F4 | no | yes | differs | past | **ping** |
| F5 | no | yes | differs | `null` | **ping** |
| F6 | no | yes | differs | exactly `now` | **ping** (`<` is strict) |
| F7 | yes | none | — | future | **ping** — force bypasses everything |
| F8 | yes | yes | matches | future | **ping** |
| F9 | — | yes | — | past | Token missing → `run.failure`, **zero fetch calls** |
| F10 | — | yes | — | past | Success → KV written: `nextResetAt` from header, `firedTarget` = slot ISO, `lastOutcome: "success"` |
| F11 | yes | none | — | — | Success → `firedTarget` **preserved** from prior state (the `?? state.firedTarget` branch) |
| F12 | — | yes | — | past | Failure → old `nextResetAt`/`firedTarget` kept, `lastPingAt` updated, `lastOutcome: "failure"` |
| F13 | — | yes | — | past | Success with **no** reset header → `newResetSource: "fallback:+5h"` |
| F14 | cron trigger | | | | `driftMs` = started − scheduledTime; `scheduledAt` ISO present |
| F15 | manual trigger | | | | `driftMs` and `scheduledAt` both `null` |
| F16 | `VERBOSE=false`, no target | | | | no log line emitted, still returns `skipped` |

F1 needs a KV read counter — wrap the binding in a counting proxy for that one
test. It is the assertion that protects the "most ticks cost nothing" property
the whole design is built around.

### G. `index.ts` handlers — 12 cases

| # | Case | Expect |
|---|---|---|
| G1 | `SELF.scheduled()` | `tick` called with `trigger: "cron"`, `controller.cron`, `scheduledTime`; `waitUntil` promise settles |
| G2 | `GET /health` | 200; full JSON shape; `catchupHorizonMinutes` echoed |
| G3 | `/health`, no token | `tokenConfigured: false` |
| G4 | `/health`, no `DEBUG_TRIGGER_SECRET` | `manualTriggerEnabled: false` |
| G5 | `/health` inside a slot / outside one | `currentTargetSlot` set / `null` |
| G6 | `/health` with populated state | `nextResetAtIso` + `minutesUntilReset` computed |
| G7 | `/health` with empty state | both `null` |
| G8 | **`/health` with `TARGETS_LOCAL="abc"`** | currently an unhandled throw. Pin it; see Finding 2 |
| G9 | `GET /nope` | 404, `"Not found. Try /health or POST /run."` |
| G10 | `POST /run`, secret unset | 403 |
| G11 | `POST /run`, wrong bearer / no header | 401 (both) |
| G12 | `POST /run` authorized; `?force=1` → forced; absent or `?force=0` → not; failing tick → **500** | |

---

## 5. Findings surfaced while planning

These are pre-existing behaviours, not test-tooling problems. The plan is to
**pin them as-is first** (so the suite documents reality), then decide fixes
separately — a test that asserts a bug is still better than no test.

1. **`CATCHUP_HORIZON_MINUTES` has no validation.** `Number(env.X ?? 240)` — `??`
   only catches `undefined`/`null`, so `""` yields a horizon of `0`, and a typo
   like `"240m"` yields `NaN`, which makes every `<=` comparison false and the
   Worker **silently never pings again**. Cases A13/A14. A validated fallback
   with a warning log is the obvious fix.
2. **`parseTargets` throws inside both handlers, uncaught.** In `fetch` that is
   an opaque 500; in `scheduled` it rejects inside `ctx.waitUntil` and the tick
   dies with only a platform-level error. A bad `TARGETS_LOCAL` deploy is
   therefore near-invisible. Case G8.
3. **`retry-after` is honoured without a cap.** A `retry-after: 3600` makes the
   Worker sleep an hour inside the invocation, well past any sane CPU/wall-clock
   limit. Case D10; a `Math.min(retryAfter, 60)` cap is the fix.
4. **`resetFromHeaders` trusts the header's magnitude.** If the API ever sent
   milliseconds instead of seconds, `seconds * 1000` lands in the year ~57000
   and gating would block every future ping forever. A sanity bound
   (`at < now + 24h`) would fail safe. Not currently a case — worth adding with
   the fix.

---

## 6. Layout and conventions

```
worker/
  src/            # as in §2
  test/
    setup.ts
    helpers.ts            # env builders, fixed-clock factory, KV counting proxy
    characterization.test.ts
    config.test.ts
    schedule.test.ts
    anthropic.test.ts
    state.test.ts
    tick.test.ts
    index.test.ts
  vitest.config.ts
  docs/{TEST_BRIEF.md,TEST_PLAN.md}
```

- **No real time.** Every test passes a fixed `now`. A test that reads the
  system clock is a test that fails in November.
- **No real network.** `disableNetConnect()` enforces it.
- **Assert on emitted events, not just return values.** The logs *are* the
  production interface for this Worker — `wrangler tail` is the only way anyone
  observes it — so `run.skipped`/`run.success` shape deserves assertions. Spy on
  `console.log` and parse the JSON line.
- Name DST tests with the date: `"29 Mar 2026 — spring forward"` beats
  `"handles DST"` when it fails a year from now.

## 7. Effort

| Phase | Work | Est. |
|---|---|---|
| 0 | Characterization net | 1h |
| 1 | Refactor + scaffolding | 2h |
| 2 | Pure units (A–C, 53 cases) | 2h |
| 3 | I/O units (D–F, 36 cases) | 2h |
| 4 | Handlers + gap-closing (G, 12 cases) | 1h |
| 5 | CI | 0.5h |
| | **Total** | **~8.5h** |

## 8. Implementation notes (post-execution)

The plan above was written before implementation; two details of the installed
`@cloudflare/vitest-pool-workers@0.22.0` didn't match what was assumed, and are
recorded here rather than silently edited away above:

- **No `defineWorkersConfig`.** This version exposes a Vite plugin,
  `cloudflareTest(options)`, used as `plugins: [cloudflareTest({...})]` in a
  plain `defineConfig` from `vitest/config`, rather than the wrapped config
  helper described in §3. `vitest.config.mts` uses `.mts` specifically because
  the plugin package is ESM-only and this project's `package.json` has no
  `"type": "module"`.
- **No `fetchMock` export.** The undici-mocking helper documented for earlier
  pool versions isn't present in this one — confirmed absent from both the
  type declarations and the built runtime module. §1's plan to intercept
  outbound HTTP that way doesn't apply. In its place: the `fetchImpl`/`sleep`
  seams from §2 do all the outbound-call substitution work, and
  `test/setup.ts` installs a global `fetch` guard (`vi.stubGlobal`) that throws
  on any unmocked call, so the "never spend a real rate-limit window" guarantee
  holds regardless of which mocking API a given pool version offers.
- **A dedicated `wrangler.test.toml`.** The real `wrangler.toml`'s
  `compatibility_date` is normally kept current; the workerd binary bundled
  with a given pool release lags behind by design. Rather than back-date the
  deploy config to chase the test tooling, tests point at a minimal
  `wrangler.test.toml` (name, main, an older `compatibility_date`, and the KV
  binding) that is never used for `wrangler deploy`.

All four bugs in §5 were fixed as part of the same change that built the test
suite (not deferred to a follow-up as §8 originally floated), since the
refactor needed to touch every one of those call sites anyway: each is pinned
by a named test (see the "bug fix" cases across `config.test.ts`,
`anthropic.test.ts`, and `tick.test.ts`) asserting the *fixed* behavior.

Final result: **100% statements/branches/functions/lines** over `src/`, two
`istanbul ignore` exclusions (both documented inline) for branches that are
genuinely unreachable given the code's own invariants — not skipped because a
test was hard to write.

## 9. Open questions

1. ~~Fix the findings in §5 as part of this work, or file them separately?~~
   **Resolved:** fixed in the same change (see §8) — the refactor touched every
   affected call site regardless, so deferring would have meant a second pass
   over the same lines. Each fix is pinned by a named "bug fix" test.
2. **Is `100%` a hard CI gate or a ratchet?** Recommendation: hard gate at 100%
   from day one. The codebase is ~500 lines; the moment it becomes a ratchet it
   becomes 94% forever. Implemented as a hard gate in `vitest.config.mts` and
   `.github/workflows/test.yml`.
3. **Is one nightly live smoke test against the real API worth a rate-limit
   window?** Probably not — the mocked contract plus the existing
   `wrangler tail` observability covers it, and a live test costs the very thing
   the Worker exists to protect. Not implemented.
