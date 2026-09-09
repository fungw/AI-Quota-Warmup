# AI-Quote-Warmup Worker

Cloudflare Worker that warms configured AI-provider quotas at predictable times
of day. Claude Code's 5-hour rate-limit window is gated from its reset header;
OpenAI is tracked independently from the same cron tick.

## Providers

AI-Quote-Warmup currently supports **Claude** and **OpenAI** only. Other AI
providers are not supported yet.

`WARMUP_PROVIDERS` is a comma-separated list of providers to run on each due
target. It defaults to `claude` for existing deployments:

| Value | Credential | Behaviour |
|---|---|---|
| `claude` (default) | `CLAUDE_CODE_OAUTH_TOKEN` | Preserves the original Claude Code 5-hour-window logic. |
| `openai` | `OPENAI_API_KEY` | Sends a Responses API request at each target slot. OpenAI API rate limits are request/token buckets, not a documented Claude-style 5-hour session window, so the Worker does **not** fabricate or gate on a five-hour reset. |

For both subscriptions, set `WARMUP_PROVIDERS = "claude,openai"`. Each provider
has independent KV state and credentials, so a missing or failed credential
does not stop the other provider. `WARMUP_PROVIDER` remains a deprecated
single-provider compatibility alias.

The OpenAI integration uses `POST /v1/responses`, Bearer API-key authentication,
`store: false`, and defaults to `gpt-5.2`. Override the model with `GPT_MODEL`
when needed. This affects OpenAI Platform API usage and billing; it does not
warm or reset limits for the ChatGPT website/app subscription.

To switch to GPT:

```bash
pnpm wrangler secret put OPENAI_API_KEY
# Set WARMUP_PROVIDERS = "claude,openai" (or "openai") in wrangler.toml.
pnpm run deploy
```

## How it decides to ping

A warm-up only opens a new window if the previous one has already expired. A
ping that lands inside an open window is silently wasted — and because a late
ping pushes the boundary later, one delay can swallow the *next* scheduled ping
too, cascading through the day. A fixed cron cannot see any of this.

So the cron ticks every 10 minutes and the Worker decides:

```
if no TARGETS_LOCAL slot in the last CATCHUP_HORIZON_MINUTES  -> skip
if this slot was already served                             -> skip
if the stored window reset time hasn't passed yet           -> skip, retry next tick
otherwise                                                   -> ping, store the new reset
```

The reset time is read from `anthropic-ratelimit-unified-5h-reset` on every
response, so the schedule re-anchors to the real boundary on each ping instead
of extrapolating. A late trigger costs minutes, not a window.

There is no cheap way to *check* the window: reading the header requires a
request, and a request opens a window if none is open. Hence the KV state — the
Worker remembers rather than polls. Skipped ticks cost one KV read and no API
call.

Note that 24 isn't divisible by 5. The default targets give four windows a day
with a deliberate ~9h gap overnight, in exchange for boundaries that stay put.

## Setup

1. **Create a Cloudflare account**, if you don't already have one, at
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). The
   free plan is enough — Cron Triggers and Workers KV are both available on
   it.

2. **Install dependencies:**

   ```bash
   cd worker
   pnpm install
   ```

3. **Log in to Cloudflare** so `wrangler` can deploy on your behalf. This
   opens a browser window to authorize the CLI:

   ```bash
   pnpm wrangler login
   ```

4. **Generate a Claude Code OAuth token** (required when `claude` is included
   in `WARMUP_PROVIDERS`). This is what the Worker uses to ping the Anthropic
   API as you:

   ```bash
   claude setup-token
   ```

   Copy the token it prints.

5. **Set the secret on the Worker.** `wrangler secret put` prompts for a
   value — paste the token from the previous step:

   ```bash
   pnpm wrangler secret put CLAUDE_CODE_OAUTH_TOKEN
   ```

6. **Add OpenAI** (required when `openai` is included in
   `WARMUP_PROVIDERS`). Create an API key at
   [platform.openai.com/api-keys](https://platform.openai.com/api-keys), then
   store it as a Worker secret:

   ```bash
   pnpm wrangler secret put OPENAI_API_KEY
   ```

   In `wrangler.toml`, set `WARMUP_PROVIDERS = "claude,openai"` to enable both
   providers, or `WARMUP_PROVIDERS = "openai"` for OpenAI only. OpenAI API usage
   requires OpenAI Platform billing/credits and is separate from a ChatGPT
   subscription.

7. **Create the KV namespace** the Worker uses to remember window state:

   ```bash
   pnpm wrangler kv namespace create WARMUP_STATE
   ```

   This prints an `id`. Paste it into `wrangler.toml`, replacing
   `id = "REPLACE_ME"`.

8. **Edit `wrangler.toml`** to fit your schedule:

   - `TARGET_TIMEZONE` — set to your own IANA zone (e.g. `America/New_York` / `Europe/Dublin`), so `TARGETS_LOCAL` is read in your local time rather than the `UTC` default.
   - `TARGETS_LOCAL` — adjust the target wall-clock times if the defaults (`06:00,11:00,16:00,21:00`) don't fit your schedule.

9. **Deploy:**

   ```bash
   pnpm run deploy
   ```

## Testing

```bash
pnpm test              # runs the suite once
pnpm run test:watch    # reruns on save
pnpm run test:coverage # runs with the 100% coverage gate enforced
pnpm run typecheck     # src/ and test/ separately, since they use different type roots
```

Tests run inside the real Workers runtime via `@cloudflare/vitest-pool-workers`
(so `Intl`-based DST arithmetic and KV behave exactly as in production), against
`wrangler.test.toml` — a test-only config, never used for `wrangler deploy`.
No test ever makes a real call to `api.anthropic.com`: a global `fetch` guard in
`test/setup.ts` throws if one slips through, and the retry/ping logic is
exercised via injected `fetchImpl`/`sleep`/`now` seams instead. See
[`docs/TEST_PLAN.md`](docs/TEST_PLAN.md) for the full case matrix and rationale.
CI (`.github/workflows/test.yml`) runs `typecheck` and `test:coverage` on every
push and PR.

## Verifying it works

The Worker has no public route (`workers_dev = false`), so verification goes
through logs rather than HTTP:

```bash
pnpm run tail        # live ticks as they fire
```

Every 10 minutes you should see a `run.skipped` (usually `no-target`), and at
each `TARGETS_LOCAL` slot a `run.success`. Past runs are also browsable in the
Workers Logs dashboard, since `[observability]` is enabled — that's the record
to check the morning after, when `tail` wasn't running.

To exercise the ping path without waiting for a slot, run it locally against
the real API:

```bash
printf 'CLAUDE_CODE_OAUTH_TOKEN=<token>\nDEBUG_TRIGGER_SECRET=local\n' > .dev.vars
pnpm wrangler dev --test-scheduled

# in another shell — fires the cron path
curl "http://localhost:8799/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*"

# or the gating logic on demand, with ?force=1 to bypass it
curl -X POST "http://localhost:8799/run" -H "Authorization: Bearer local"
```

`.dev.vars` is gitignored. Local `wrangler dev` uses its own KV store under
`.wrangler/`, so this never touches production state.

If you do want `/health` and `/run` reachable in production, set
`workers_dev = true`, redeploy, and set `DEBUG_TRIGGER_SECRET` — without that
secret `/run` stays disabled (403), and `/health` is unauthenticated, so it
exposes your target times and window state to anyone who guesses the URL.

## What gets logged

One JSON line per event. The `run.success` / `run.failure` summary carries:

| Field | Why it's there |
|---|---|
| `runId` | Correlates the attempt lines with the summary |
| `scheduledAt` | When the cron was **due** |
| `startedAt` | When the Worker **actually** ran |
| `driftMs` | The gap between those two measured |
| `finishedAt` / `totalMs` | Wall-clock cost of the whole run |
| `url` / `model` | Exactly what was hit |
| `provider` | The provider for each per-provider event/result |
| `tokenFingerprint` | `len=… …abcd`, to confirm *which* token is deployed |
| `attempts[]` | Per-try status, duration, and error body |
| `attempts[].headers` | Anthropic's `request-id` and `anthropic-ratelimit-*` state |
| `attempts[].usage` | Token counts from the response |
| `reply` | What Claude actually said |
| `targetSlot` / `minutesSinceTarget` | Which slot this tick was serving, and how late |
| `knownResetAt` / `minutesUntilReset` | The window boundary the Worker is gating on |
| `newResetAt` / `newResetSource` | Boundary after the ping; `header` or `fallback:+5h` |
| `rateLimit` | Full `anthropic-ratelimit-*` set, incl. 5h/7d utilization |
| `reason` (on `run.skipped`) | `no-target`, `already-served`, `window-still-open` |

With multiple providers, `/run` returns `action: "aggregate"` and a `results`
array containing one report per provider. `/health` returns the enabled
providers, model, credential-presence flag, and independent state for each.

A `no-target` line carries no window fields at all — that decision is made from
the clock before KV is read, so those ticks cost no storage read either.

Useful queries once it's running:

```
event = "run.failure"                 # every failed run
event = "run.skipped" AND reason = "window-still-open"
                                      # gating did its job; a fixed cron would
                                      # have wasted this slot
minutesSinceTarget > 30               # slots being served late
newResetSource = "fallback:+5h"       # the reset header stopped being sent
```

Watch `rateLimit["anthropic-ratelimit-unified-7d-utilization"]` too — it's how
you'd notice the warmups eating into the weekly budget.

Set `VERBOSE = "false"` in `wrangler.toml` to drop the per-attempt lines and
keep just the summary, once you're confident it works.

## Schedule

`crons = ["*/10 * * * *"]` — ticks every 10 minutes; the Worker gates the
actual pings. Change *when* windows open via `TARGETS_LOCAL` in `wrangler.toml`
(default `06:00,11:00,16:00,21:00`), not via the cron. `TARGETS_LOCAL` is
interpreted in `TARGET_TIMEZONE` (default `UTC`; set this to your own IANA
zone, e.g. `Europe/Dublin`); the Worker resolves each target's UTC offset per
day via `Intl`, so it tracks DST automatically — no manual adjustment when the
clocks change.

`CATCHUP_HORIZON_MINUTES` (default 240) is how long after a target the Worker
keeps retrying if the previous window is still open. Keep it below the gap
between targets.
