import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "../src/tick";
import { STATE_KEY, stateKey, writeState, type State } from "../src/state";
import { jsonResponse, makeEnv, fixedNow, textResponse } from "./helpers";

const TZ_ENV = { TARGET_TIMEZONE: "UTC", TARGETS_LOCAL: "06:00", CATCHUP_HORIZON_MINUTES: "240" };
const TARGET_06 = Date.UTC(2026, 5, 15, 6, 0); // 15 Jun 2026 06:00 UTC
const RUNNER_URL = "https://ai-quota-openai.fly.dev/warmup";
const RUNNER_ENV = { GPT_WARMUP_URL: RUNNER_URL, GPT_WARMUP_SECRET: "test-runner-secret" };
const runnerResponse = (overrides: Record<string, unknown> = {}) => ({
    success: true,
    action: "pinged",
    reply: "Warmed up!",
    nextResetAt: TARGET_06 + 5 * 60 * 60 * 1000,
    rateLimits: {
        limitId: "codex",
        planType: "plus",
        primary: {
            usedPercent: 1,
            windowDurationMins: 300,
            resetsAt: (TARGET_06 + 5 * 60 * 60 * 1000) / 1000,
        },
        secondary: null,
    },
    ...overrides,
});

async function countingKv(base: KVNamespace) {
    let reads = 0;
    return {
        kv: {
            get: (...args: Parameters<KVNamespace["get"]>) => {
                reads++;
                return base.get(...args);
            },
            put: base.put.bind(base),
            delete: base.delete.bind(base),
            list: base.list.bind(base),
        } as unknown as KVNamespace,
        getReads: () => reads,
    };
}

describe("tick gating", () => {
    beforeEach(async () => {
        await env.WARMUP_STATE.delete(STATE_KEY);
        await env.WARMUP_STATE.delete(stateKey("openai"));
    });

    it("F1: no target -> skipped, and KV is never read", async () => {
        const { kv, getReads } = await countingKv(env.WARMUP_STATE);
        const testEnv = makeEnv({ WARMUP_STATE: kv, ...TZ_ENV });
        // Far from the only target (06:00) and outside the 240min horizon.
        const now = fixedNow(new Date(Date.UTC(2026, 5, 15, 14, 0)).toISOString());
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect(report.action).toBe("skipped");
        expect((report as { reason: string }).reason).toBe("no-target");
        expect(getReads()).toBe(0);
    });

    it("F2: target already served -> skipped as already-served", async () => {
        await writeState(makeEnv({ WARMUP_STATE: env.WARMUP_STATE }), {
            nextResetAt: null,
            firedTarget: new Date(TARGET_06).toISOString(),
            lastPingAt: null,
            lastOutcome: null,
        } as State);
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect(report.action).toBe("skipped");
        expect((report as { reason: string }).reason).toBe("already-served");
    });

    it("F3: window still open -> skipped", async () => {
        await writeState(makeEnv({ WARMUP_STATE: env.WARMUP_STATE }), {
            nextResetAt: TARGET_06 + 60_000,
            firedTarget: null,
            lastPingAt: null,
            lastOutcome: null,
        } as State);
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect(report.action).toBe("skipped");
        expect((report as { reason: string }).reason).toBe("window-still-open");
    });

    it("F4: reset time already past -> pings", async () => {
        await writeState(makeEnv({ WARMUP_STATE: env.WARMUP_STATE }), {
            nextResetAt: TARGET_06 - 60_000,
            firedTarget: null,
            lastPingAt: null,
            lastOutcome: null,
        } as State);
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const fetchImpl = () => Promise.resolve(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
        const report = await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null },
            { now, fetchImpl }
        );
        expect(report.action).toBe("pinged");
        expect(report.success).toBe(true);
    });

    it("F5: nextResetAt null -> pings", async () => {
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const fetchImpl = () => Promise.resolve(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
        const report = await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null },
            { now, fetchImpl }
        );
        expect(report.action).toBe("pinged");
        expect(report.success).toBe(true);
    });

    it("uses the Fly Codex runner and persists its authoritative reset", async () => {
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            ...RUNNER_ENV,
            WARMUP_PROVIDER: "openai",
        });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        let calledUrl: string | URL | Request | undefined;
        const fetchImpl = (url: string | URL | Request) => {
            calledUrl = url;
            return Promise.resolve(jsonResponse(runnerResponse()));
        };
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now, fetchImpl });
        expect(calledUrl).toBe(RUNNER_URL);
        expect(report.success).toBe(true);
        expect((report as { newResetSource: string }).newResetSource).toBe("runner:codex-rate-limits");
        expect((report as { newResetAt: string }).newResetAt).toBe(new Date(TARGET_06 + 5 * 60 * 60 * 1000).toISOString());
    });

    it("accepts a live runner skip and persists the authoritative reset", async () => {
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            ...RUNNER_ENV,
            WARMUP_PROVIDER: "openai",
        });
        const reset = TARGET_06 + 90_000;
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const report = await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null },
            {
                now,
                fetchImpl: () => Promise.resolve(jsonResponse(runnerResponse({
                    action: "skipped",
                    reason: "window-still-open",
                    nextResetAt: reset,
                }))),
            },
        );
        expect(report).toMatchObject({
            action: "skipped",
            reason: "window-still-open",
            success: true,
            newResetAt: new Date(reset).toISOString(),
            newResetSource: "runner:codex-rate-limits",
        });
        expect((await env.WARMUP_STATE.get<State>(stateKey("openai"), "json"))?.nextResetAt).toBe(reset);
    });

    it("retains a null reset when a live runner skip cannot report one", async () => {
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            ...RUNNER_ENV,
            WARMUP_PROVIDER: "openai",
        });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const report = await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null },
            {
                now,
                fetchImpl: () => Promise.resolve(jsonResponse(runnerResponse({
                    action: "skipped",
                    reason: "window-still-open",
                    nextResetAt: null,
                }))),
            },
        );
        expect((report as { newResetAt: null }).newResetAt).toBeNull();
    });

    it("reports a successful OpenAI ping even if the runner omits a reset", async () => {
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            ...RUNNER_ENV,
            WARMUP_PROVIDER: "openai",
        });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const report = await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null },
            {
                now,
                fetchImpl: () => Promise.resolve(jsonResponse(runnerResponse({
                    reply: undefined,
                    nextResetAt: null,
                    rateLimits: null,
                }))),
            },
        );
        expect(report).toMatchObject({
            action: "pinged",
            success: true,
            newResetAt: null,
            newResetSource: "runner:no-reset-reported",
        });
    });

    it("records an OpenAI runner failure without replacing existing state", async () => {
        const previous: State = {
            nextResetAt: TARGET_06 - 60_000,
            firedTarget: "2020-01-01T00:00:00.000Z",
            lastPingAt: null,
            lastOutcome: null,
        };
        await writeState(makeEnv({ WARMUP_STATE: env.WARMUP_STATE }), previous, "openai");
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            ...RUNNER_ENV,
            WARMUP_PROVIDER: "openai",
        });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const report = await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null },
            { now, fetchImpl: () => Promise.resolve(textResponse("denied", { status: 401 })) },
        );
        expect(report).toMatchObject({ action: "pinged", success: false, error: "denied" });
        expect(await env.WARMUP_STATE.get<State>(stateKey("openai"), "json")).toMatchObject({
            nextResetAt: previous.nextResetAt,
            firedTarget: previous.firedTarget,
            lastOutcome: "failure",
        });
    });

    it("uses the run id as OpenAI's idempotency key for a forced off-schedule ping", async () => {
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            ...RUNNER_ENV,
            WARMUP_PROVIDER: "openai",
        });
        const now = fixedNow(new Date(Date.UTC(2026, 5, 15, 14, 0)).toISOString());
        let idempotencyKey = "";
        const report = await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null, force: true },
            {
                now,
                fetchImpl: async (_url, init) => {
                    idempotencyKey = (init?.headers as Record<string, string>)["Idempotency-Key"];
                    return jsonResponse(runnerResponse());
                },
            },
        );
        expect(idempotencyKey).toBe(report.runId);
    });

    it("fails fast when the selected OpenAI provider has no runner secret", async () => {
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            WARMUP_PROVIDER: "openai",
            GPT_WARMUP_URL: RUNNER_URL,
            GPT_WARMUP_SECRET: "",
        });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect(report.success).toBe(false);
        expect((report as { error: string }).error).toMatch(/GPT_WARMUP_SECRET is not set/);
    });

    it("fails fast when the selected OpenAI provider has no runner URL", async () => {
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            WARMUP_PROVIDER: "openai",
            GPT_WARMUP_URL: "",
            GPT_WARMUP_SECRET: "test-runner-secret",
        });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect(report.success).toBe(false);
        expect((report as { error: string }).error).toMatch(/GPT_WARMUP_URL is not set/);
    });

    it("fails fast when the selected OpenAI provider omits the runner URL", async () => {
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            WARMUP_PROVIDER: "openai",
            GPT_WARMUP_URL: undefined,
            GPT_WARMUP_SECRET: "test-runner-secret",
        });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect((report as { error: string }).error).toMatch(/GPT_WARMUP_URL is not set/);
    });

    it("F6: nextResetAt exactly equal to now -> pings (strict <)", async () => {
        await writeState(makeEnv({ WARMUP_STATE: env.WARMUP_STATE }), {
            nextResetAt: TARGET_06,
            firedTarget: null,
            lastPingAt: null,
            lastOutcome: null,
        } as State);
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const fetchImpl = () => Promise.resolve(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
        const report = await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null },
            { now, fetchImpl }
        );
        expect(report.action).toBe("pinged");
    });

    it("F7: force bypasses no-target gating entirely", async () => {
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(Date.UTC(2026, 5, 15, 14, 0)).toISOString()); // far from any target
        const fetchImpl = () => Promise.resolve(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
        const report = await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null, force: true },
            { now, fetchImpl }
        );
        expect(report.action).toBe("pinged");
        expect(report.success).toBe(true);
    });

    it("F8: force bypasses already-served + window-still-open", async () => {
        await writeState(makeEnv({ WARMUP_STATE: env.WARMUP_STATE }), {
            nextResetAt: TARGET_06 + 60_000,
            firedTarget: new Date(TARGET_06).toISOString(),
            lastPingAt: null,
            lastOutcome: null,
        } as State);
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const fetchImpl = () => Promise.resolve(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
        const report = await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null, force: true },
            { now, fetchImpl }
        );
        expect(report.action).toBe("pinged");
    });

    it("F9: missing token -> run.failure with zero fetch calls", async () => {
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV, CLAUDE_CODE_OAUTH_TOKEN: "" });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        // No fetchImpl provided; the global guard in test/setup.ts throws if fetch
        // is ever reached for real, which is exactly the assertion we want.
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect(report.action).toBe("pinged");
        expect(report.success).toBe(false);
        expect((report as { error: string }).error).toMatch(/CLAUDE_CODE_OAUTH_TOKEN is not set/);
    });

    it("F10: success writes nextResetAt/firedTarget/lastOutcome to KV", async () => {
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const resetAtSeconds = (TARGET_06 + 5 * 60 * 60 * 1000) / 1000;
        const fetchImpl = () =>
            Promise.resolve(
                jsonResponse(
                    { content: [{ type: "text", text: "ok" }] },
                    { headers: { "anthropic-ratelimit-unified-5h-reset": String(resetAtSeconds) } }
                )
            );
        await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now, fetchImpl });

        const stored = await env.WARMUP_STATE.get<State>(STATE_KEY, "json");
        expect(stored?.nextResetAt).toBe(resetAtSeconds * 1000);
        expect(stored?.firedTarget).toBe(new Date(TARGET_06).toISOString());
        expect(stored?.lastOutcome).toBe("success");
    });

    it("F11: force with no target preserves prior firedTarget on success", async () => {
        await writeState(makeEnv({ WARMUP_STATE: env.WARMUP_STATE }), {
            nextResetAt: null,
            firedTarget: "2020-01-01T00:00:00.000Z",
            lastPingAt: null,
            lastOutcome: null,
        } as State);
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(Date.UTC(2026, 5, 15, 14, 0)).toISOString()); // no active target
        const fetchImpl = () => Promise.resolve(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
        await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null, force: true },
            { now, fetchImpl }
        );
        const stored = await env.WARMUP_STATE.get<State>(STATE_KEY, "json");
        expect(stored?.firedTarget).toBe("2020-01-01T00:00:00.000Z");
    });

    it("F12: failure preserves old nextResetAt/firedTarget, updates lastPingAt/lastOutcome", async () => {
        await writeState(makeEnv({ WARMUP_STATE: env.WARMUP_STATE }), {
            nextResetAt: TARGET_06 - 60_000,
            firedTarget: "2020-01-01T00:00:00.000Z",
            lastPingAt: null,
            lastOutcome: null,
        } as State);
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const fetchImpl = () => Promise.resolve(textResponse("bad", { status: 400 }));
        await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now, fetchImpl });

        const stored = await env.WARMUP_STATE.get<State>(STATE_KEY, "json");
        expect(stored?.nextResetAt).toBe(TARGET_06 - 60_000);
        expect(stored?.firedTarget).toBe("2020-01-01T00:00:00.000Z");
        expect(stored?.lastOutcome).toBe("failure");
        expect(stored?.lastPingAt).not.toBeNull();
    });

    it("F13: success with no reset header reports fallback:+5h", async () => {
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const fetchImpl = () => Promise.resolve(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
        const report = await tick(
            testEnv,
            { trigger: "manual", cron: null, scheduledTime: null },
            { now, fetchImpl }
        );
        expect((report as { newResetSource: string }).newResetSource).toBe("fallback:+5h");
    });

    it("F14: cron trigger reports driftMs and scheduledAt", async () => {
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const scheduledTime = TARGET_06 - 5000;
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const report = await tick(testEnv, { trigger: "cron", cron: "*/10 * * * *", scheduledTime }, { now });
        expect(report.driftMs).toBe(5000);
        expect(report.scheduledAt).toBe(new Date(scheduledTime).toISOString());
    });

    it("F15: manual trigger reports null driftMs and scheduledAt", async () => {
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV });
        const now = fixedNow(new Date(Date.UTC(2026, 5, 15, 14, 0)).toISOString());
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect(report.driftMs).toBeNull();
        expect(report.scheduledAt).toBeNull();
    });

    it("F16: VERBOSE=false suppresses the no-target skip log", async () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV, VERBOSE: "false" });
        const now = fixedNow(new Date(Date.UTC(2026, 5, 15, 14, 0)).toISOString());
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect(report.action).toBe("skipped");
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it("bug fix: an invalid TARGETS_LOCAL reports run.failure instead of throwing", async () => {
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, TARGETS_LOCAL: "not-a-time" });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect(report.success).toBe(false);
        expect((report as { error: string }).error).toMatch(/Invalid configuration/);
    });

    it("runs both providers independently and keeps provider state isolated", async () => {
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            WARMUP_PROVIDERS: "claude,openai",
            ...RUNNER_ENV,
        });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const urls: string[] = [];
        const fetchImpl = (url: string | URL | Request) => {
            urls.push(String(url));
            return Promise.resolve(
                String(url) === RUNNER_URL
                    ? jsonResponse(runnerResponse())
                    : jsonResponse({ content: [{ type: "text", text: "ok" }] }),
            );
        };
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now, fetchImpl });
        expect(report.action).toBe("aggregate");
        expect(report.success).toBe(true);
        expect((report as { results: Array<{ provider: string; success: boolean }> }).results).toEqual([
            expect.objectContaining({ provider: "claude", success: true }),
            expect.objectContaining({ provider: "openai", success: true }),
        ]);
        expect(urls).toEqual(expect.arrayContaining(["https://api.anthropic.com/v1/messages", RUNNER_URL]));
        expect(await env.WARMUP_STATE.get("warmup-state:claude", "json")).not.toBeNull();
        expect(await env.WARMUP_STATE.get("warmup-state:openai", "json")).not.toBeNull();
    });

    it("does not let a missing provider secret block the other provider", async () => {
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            ...RUNNER_ENV,
            WARMUP_PROVIDERS: "claude,openai",
            CLAUDE_CODE_OAUTH_TOKEN: "",
        });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        const fetchImpl = () => Promise.resolve(jsonResponse(runnerResponse()));
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now, fetchImpl });
        expect(report.success).toBe(false);
        const results = (report as { results: Array<{ provider: string; success: boolean; error?: string }> }).results;
        expect(results).toEqual([
            expect.objectContaining({ provider: "claude", success: false, error: expect.stringMatching(/CLAUDE_CODE_OAUTH_TOKEN/) }),
            expect.objectContaining({ provider: "openai", success: true }),
        ]);
    });

    it("skips both providers without reading KV when no target is due", async () => {
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV, WARMUP_PROVIDERS: "claude,openai" });
        const now = fixedNow(new Date(Date.UTC(2026, 5, 15, 14, 0)).toISOString());
        const report = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect(report).toMatchObject({ action: "aggregate", success: true });
        expect((report as { results: Array<{ reason: string }> }).results.map((r) => r.reason)).toEqual(["no-target", "no-target"]);
    });

    it("suppresses multi-provider no-target logs when VERBOSE=false", async () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE, ...TZ_ENV, WARMUP_PROVIDERS: "claude,openai", VERBOSE: "false" });
        const now = fixedNow(new Date(Date.UTC(2026, 5, 15, 14, 0)).toISOString());
        await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).not.toContain('"event":"run.skipped"');
        spy.mockRestore();
    });

    it("does not call either provider again for a duplicate target", async () => {
        const testEnv = makeEnv({
            WARMUP_STATE: env.WARMUP_STATE,
            ...TZ_ENV,
            ...RUNNER_ENV,
            WARMUP_PROVIDERS: "claude,openai",
        });
        const now = fixedNow(new Date(TARGET_06).toISOString());
        let calls = 0;
        const fetchImpl = (url: string | URL | Request) => {
            calls++;
            return Promise.resolve(
                String(url) === RUNNER_URL
                    ? jsonResponse(runnerResponse())
                    : jsonResponse({ content: [{ type: "text", text: "ok" }] }),
            );
        };
        await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now, fetchImpl });
        const duplicate = await tick(testEnv, { trigger: "manual", cron: null, scheduledTime: null }, { now, fetchImpl });
        expect(calls).toBe(2);
        expect((duplicate as { results: Array<{ reason: string }> }).results.map((r) => r.reason)).toEqual(["already-served", "already-served"]);
    });
});
