# 🔥 Quota Warmup 🚀

> Automatically warm configured AI-provider quotas before your work session.

---

## The Problem

AI providers enforce rate limits and usage windows that can begin with your first request. For Claude Code, this is a **rolling 5-hour window** — so if you sleep in and start at noon, you get a short window for the day.

**Solution:** Send a tiny warm-up message before you plan to work. The configured providers receive their own request, with provider-specific state and gating.

---

## How It Works

This runs as a **Cloudflare Worker** (see [`worker/`](worker/)). By default it
w arms Claude Code. Set `WARMUP_PROVIDERS = "claude,openai"` to warm both
providers from one deployment; see the provider notes in
[`worker/README.md`](worker/README.md).

1. The Worker ticks every 10 minutes and checks whether it's near one of your configured local target times (e.g. 6 AM)
2. It pings the Anthropic API directly with your `CLAUDE_CODE_OAUTH_TOKEN`
3. It reads the `anthropic-ratelimit-unified-5h-reset` header from the response — the authoritative window boundary — and stores it, so a late or duplicate tick never wastes a ping inside an already-open window
4. Your 5-hour window starts ticking → resets much sooner after your workday begins ✅

Target times are configured in your own local timezone and stay correct across daylight saving transitions — no manual adjustment when the clocks change.

### Choosing your target times

24 hours isn't divisible by 5, so four windows a day always leaves a gap somewhere — put it where it counts. Splitting the day naively every 5 hours from a 9 AM start gives you:

```
9 AM → 2 PM → 7 PM → 12 AM
```

That last window opens at midnight, burning a ping on a window nobody's awake to use. Shift the same four windows earlier instead:

```
6 AM → 11 AM → 4 PM → 9 PM
```

Now the ~9-hour gap falls overnight, where it's free, and every window lands during hours you're actually likely to be working — much better session window allocation for the same four pings a day. This is the worker's default (`TARGETS_LOCAL = "06:00,11:00,16:00,21:00"`); adjust it to fit your own schedule.

Full setup, configuration, and the gating design are documented in [`worker/README.md`](worker/README.md).

---

## License

[MIT](LICENSE)
