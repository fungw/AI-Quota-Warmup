# Window-anchoring brief

## Goal

A Claude warm-up ping must retire a target slot only when it actually opened a
fresh five-hour window. A ping that lands inside a window something else already
opened currently retires the slot permanently, so the day's first warm-up is
spent for nothing and never retried.

## Evidence

On 2026-09-18 the 06:00 Dublin target fired at 05:00:27Z and succeeded. The
response reported `anthropic-ratelimit-unified-5h-reset` = 05:10:00Z — nine and
a half minutes away. The Worker stored that reset *and* wrote the 06:00 slot to
`firedTarget`, so no further Claude ping happened until 11:00.

The window had been opened at 00:16:50Z by Claude Code's own background daemon
claiming a prewarm worker (`~/.claude/daemon.log`, `bg claimed-spare`). The same
pattern swallowed the 06:00 slot on 2, 4, 12 and 17 September. It is not user
activity and it is not something this repository can prevent at the source.

The window model consistent with every observation: the first request after a
window closes opens a new one, and the reset is the previous ten-minute boundary
plus five hours. A genuinely fresh window therefore always reports at least
~4h50m remaining. A healthy run for comparison — 2026-09-10, ping at 05:00:25Z,
reset 10:00:00Z, 4h59m35s bought.

## The change

In `runProvider` (`src/tick.ts`), for the Claude provider only, compute how much
window a successful ping bought: `reset.at - finished.getTime()`. Below the
threshold, the ping joined a window it did not open. In that case:

- store `nextResetAt` as usual — the boundary we learned is authoritative;
- record `lastPingAt` and `lastOutcome: "success"` as usual;
- but preserve the existing `state.firedTarget` instead of writing the current
  target.

The slot stays unserved, so the first tick after `nextResetAt` passes pings
again and opens a real window, provided the catch-up horizon has not expired.

There is precedent in this file. The OpenAI path already does exactly this: its
`action === "skipped"` branch writes `nextResetAt` without touching
`firedTarget`. That is why GPT kept working through the same nights. Make Claude
consistent with it.

## Threshold

Define alongside `FIVE_HOURS_MS` in `src/anthropic.ts` and export it for tests.
A fresh window can report as little as five hours minus the ten-minute rounding
minus request latency, so use 4h45m (`FIVE_HOURS_MS - 15 * 60_000`). That never
misreads a genuine anchor, and any real join leaves far less than 4h45m.

## Scope

Claude only. Leave the OpenAI pinged path alone — the Fly runner reads the live
Codex limit before spending anything and reports its own semantics.

## Termination and cost

Bounded by construction. A retry fires only once the stored `nextResetAt` has
passed, and a ping into a closed window opens a fresh one, so in practice a slot
costs at most two Claude requests. The existing 240-minute catch-up horizon
stays the outer bound: if a hostile window outlasts it, the slot is missed
exactly as it is today.

## Observability

The distinction has to be visible in logs without arithmetic. Add the bought
duration and an anchored flag to `ProviderReport`, and emit a distinct event
when a success did not anchor. Someone reading logs after a bad morning should
see "pinged, succeeded, bought nine minutes, slot not retired" directly.

## Tests

- A ping returning a reset ~9 minutes out: `firedTarget` unchanged,
  `nextResetAt` stored, report flags it unanchored, distinct event emitted.
- A follow-up tick after that reset passes, same slot, still inside the horizon:
  pings again, gets a full window, retires the slot.
- A ping returning a full five hours: slot retired — regression guard for
  today's behaviour.
- Threshold boundary: exactly at the threshold anchors, one millisecond below
  does not.
- A join whose reset outlasts the horizon: slot never retired, no ping once the
  horizon expires, no unbounded retry loop.
- OpenAI behaviour unchanged.

## Acceptance criteria

- Replaying the 17 and 18 September sequences produces a second ping that opens
  a real window before the horizon expires.
- No change to OpenAI behaviour.
- `npm run typecheck` and `npm test` pass.
- `npm run test:coverage` holds the 100% statements/branches/functions/lines
  gate. Use the repository's existing `istanbul ignore next` convention only for
  genuinely unreachable defensive branches, with the same style of comment
  explaining why.
- README "Request flow" step 4 updated to mention the join case.
