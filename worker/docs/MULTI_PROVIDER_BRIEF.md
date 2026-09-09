# Multi-provider warm-up brief

## Goal

One Cloudflare Worker deployment must be able to warm both a Claude Code
subscription and an OpenAI API subscription on the same cron tick. It must also
continue to support deployments that enable only one provider.

## Configuration

Replace the single-choice `WARMUP_PROVIDER` setting with
`WARMUP_PROVIDERS`, a comma-separated list such as `claude,openai`. The default
must be `claude` to preserve existing deployments. Reject unknown values and
duplicate entries as configuration errors. Keep `WARMUP_PROVIDER` as a
deprecated compatibility alias only if it can be done without ambiguity.

Each enabled provider needs only its own credential:

- `claude` uses `CLAUDE_CODE_OAUTH_TOKEN`.
- `openai` uses `OPENAI_API_KEY` and may use `GPT_MODEL`.

## Isolation and scheduling

Provider state is independent. Store it under provider-specific KV keys (for
example, `warmup-state:claude` and `warmup-state:openai`) so one provider's
served target, failure, or reset boundary can never suppress another's request.

At each due target, evaluate every enabled provider independently and return an
aggregate run report with one result per provider. A missing Claude credential
must not prevent OpenAI from running, and vice versa. The overall run succeeds
only when every enabled provider succeeds or is legitimately skipped; failures
must remain visible per provider.

## Provider semantics

Claude keeps the existing `anthropic-ratelimit-unified-5h-reset` gating and
fallback behavior. OpenAI must run at most once for a target slot, but must not
pretend OpenAI has the same five-hour subscription window: its API
rate-limit headers concern request/token buckets rather than a documented
five-hour session boundary.

## Interfaces and observability

`/health` should expose the enabled providers, each provider's model and
credential-presence flag, plus state keyed by provider. Logs and manual `/run`
reports should include a provider field and a per-provider outcome. Preserve
the existing single-provider report shape where practical, but prefer an
unambiguous aggregate shape over misleading compatibility.

## Acceptance criteria

- `WARMUP_PROVIDERS=claude,openai` makes one due tick call both APIs.
- Each provider writes and reads only its own state.
- A failure or missing secret for one provider does not block the other.
- A duplicate target tick does not call either provider again after each has
  recorded success for that target.
- Existing Claude-only configuration and tests continue to work.
- Typecheck, tests, and the repository's 100% coverage gate pass.
