import {
    createExecutionContext,
    createScheduledController,
    env,
    SELF,
    waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { STATE_KEY } from "../src/state";

describe("scheduled handler (G1)", () => {
    it("invokes the tick path via ctx.waitUntil and settles", async () => {
        const controller = createScheduledController({ cron: "*/10 * * * *", scheduledTime: Date.now() });
        const ctx = createExecutionContext();
        await worker.scheduled(controller, env, ctx);
        await waitOnExecutionContext(ctx); // resolves once ctx.waitUntil's promise settles
    });
});

describe("GET /health", () => {
    beforeEach(async () => {
        await env.WARMUP_STATE.delete(STATE_KEY);
    });

    it("returns 200 with the expected shape (G2)", async () => {
        const res = await SELF.fetch("https://example.com/health");
        expect(res.status).toBe(200);
        const body = await res.json<Record<string, unknown>>();
        expect(body.ok).toBe(true);
        expect(body).toHaveProperty("now");
        expect(body).toHaveProperty("targetsLocal");
        expect(body).toHaveProperty("targetTimezone");
        expect(body).toHaveProperty("catchupHorizonMinutes");
        expect(body).toHaveProperty("currentTargetSlot");
        expect(body).toHaveProperty("state");
    });

    it("reports tokenConfigured: true when the binding is set (G3)", async () => {
        const res = await SELF.fetch("https://example.com/health");
        const body = await res.json<Record<string, unknown>>();
        expect(body.tokenConfigured).toBe(true);
    });

    it("reports the selected OpenAI provider and model", async () => {
        const ctx = createExecutionContext();
        const res = await worker.fetch(new Request("https://example.com/health"), {
            ...env,
            WARMUP_PROVIDER: "openai",
            OPENAI_API_KEY: "test-key",
            GPT_MODEL: "test-gpt",
        }, ctx);
        const body = await res.json<Record<string, unknown>>();
        expect(body).toMatchObject({ provider: "openai", model: "test-gpt", tokenConfigured: true });
    });

    it("uses the default GPT model when no override is configured", async () => {
        const ctx = createExecutionContext();
        const res = await worker.fetch(new Request("https://example.com/health"), {
            ...env, WARMUP_PROVIDER: "openai", OPENAI_API_KEY: "test-key", GPT_MODEL: undefined,
        }, ctx);
        expect((await res.json<Record<string, unknown>>()).model).toBe("gpt-5.2");
    });

    it("reports independent health details for both providers", async () => {
        const ctx = createExecutionContext();
        const res = await worker.fetch(new Request("https://example.com/health"), {
            ...env,
            WARMUP_PROVIDERS: "claude,openai",
            CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
            OPENAI_API_KEY: "openai-key",
            GPT_MODEL: "gpt-test",
        }, ctx);
        const body = await res.json<{ providers: Array<Record<string, unknown>> }>();
        expect(body.providers).toEqual([
            expect.objectContaining({ provider: "claude", tokenConfigured: true }),
            expect.objectContaining({ provider: "openai", model: "gpt-test", tokenConfigured: true }),
        ]);
    });

    it("reports manualTriggerEnabled based on DEBUG_TRIGGER_SECRET (G4)", async () => {
        const res = await SELF.fetch("https://example.com/health");
        const body = await res.json<Record<string, unknown>>();
        expect(typeof body.manualTriggerEnabled).toBe("boolean");
    });

    it("reports the current target slot when inside a window, null otherwise (G5)", async () => {
        vi.useFakeTimers();
        try {
            // Inside the default 06:00 Europe/Dublin window (Jan, GMT: 06:00 local = 06:00Z).
            vi.setSystemTime(new Date(Date.UTC(2026, 0, 15, 6, 30)));
            const inWindow = await (await SELF.fetch("https://example.com/health")).json<Record<string, unknown>>();
            expect(typeof inWindow.currentTargetSlot).toBe("string");

            // The overnight gap: after 21:00+4h horizon, before 06:00 next day.
            vi.setSystemTime(new Date(Date.UTC(2026, 0, 15, 3, 0)));
            const outOfWindow = await (
                await SELF.fetch("https://example.com/health")
            ).json<Record<string, unknown>>();
            expect(outOfWindow.currentTargetSlot).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it("computes nextResetAtIso/minutesUntilReset for populated state (G6)", async () => {
        await env.WARMUP_STATE.put(
            STATE_KEY,
            JSON.stringify({
                nextResetAt: Date.now() + 60_000,
                firedTarget: null,
                lastPingAt: null,
                lastOutcome: null,
            })
        );
        const res = await SELF.fetch("https://example.com/health");
        const body = await res.json<{ state: Record<string, unknown> }>();
        expect(body.state.nextResetAtIso).toEqual(expect.any(String));
        expect(typeof body.state.minutesUntilReset).toBe("number");
    });

    it("returns null reset fields for empty state (G7)", async () => {
        const res = await SELF.fetch("https://example.com/health");
        const body = await res.json<{ state: Record<string, unknown> }>();
        expect(body.state.nextResetAtIso).toBeNull();
        expect(body.state.minutesUntilReset).toBeNull();
    });
});

describe("GET /health with bad config (G8, bug fix)", () => {
    it("returns 500 with an error message instead of throwing", async () => {
        const request = new Request("https://example.com/health");
        const ctx = createExecutionContext();
        const badEnv = { ...env, TARGETS_LOCAL: "not-a-time" };
        const res = await worker.fetch(request, badEnv, ctx);
        await waitOnExecutionContext(ctx);
        expect(res.status).toBe(500);
        const body = await res.json<{ ok: boolean; error: string }>();
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/Invalid configuration/);
    });
});

describe("unknown routes (G9)", () => {
    it("404s with a helpful message", async () => {
        const res = await SELF.fetch("https://example.com/nope");
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("Not found. Try /health or POST /run.");
    });
});

describe("POST /run", () => {
    it("403s when DEBUG_TRIGGER_SECRET is unset (G10)", async () => {
        const request = new Request("https://example.com/run", { method: "POST" });
        const ctx = createExecutionContext();
        const noSecretEnv = { ...env, DEBUG_TRIGGER_SECRET: undefined };
        const res = await worker.fetch(request, noSecretEnv, ctx);
        await waitOnExecutionContext(ctx);
        expect(res.status).toBe(403);
    });

    it("401s on a wrong or missing bearer token (G11)", async () => {
        const withSecretEnv = { ...env, DEBUG_TRIGGER_SECRET: "s3cret" };
        const ctx1 = createExecutionContext();
        const wrongAuth = await worker.fetch(
            new Request("https://example.com/run", {
                method: "POST",
                headers: { authorization: "Bearer wrong" },
            }),
            withSecretEnv,
            ctx1
        );
        await waitOnExecutionContext(ctx1);
        expect(wrongAuth.status).toBe(401);

        const ctx2 = createExecutionContext();
        const noAuth = await worker.fetch(
            new Request("https://example.com/run", { method: "POST" }),
            withSecretEnv,
            ctx2
        );
        await waitOnExecutionContext(ctx2);
        expect(noAuth.status).toBe(401);
    });

    it("force=1 bypasses gating; a failing tick returns 500 (G12)", async () => {
        const withSecretEnv = {
            ...env,
            DEBUG_TRIGGER_SECRET: "s3cret",
            CLAUDE_CODE_OAUTH_TOKEN: "", // guarantees tick() fails fast, before any network call
        };
        const ctx = createExecutionContext();
        const res = await worker.fetch(
            new Request("https://example.com/run?force=1", {
                method: "POST",
                headers: { authorization: "Bearer s3cret" },
            }),
            withSecretEnv,
            ctx
        );
        await waitOnExecutionContext(ctx);
        expect(res.status).toBe(500);
        const body = await res.json<{ success: boolean; error: string }>();
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/CLAUDE_CODE_OAUTH_TOKEN is not set/);
    });

    it("without force=1 (or force=0), gating still applies", async () => {
        const withSecretEnv = {
            ...env,
            DEBUG_TRIGGER_SECRET: "s3cret",
            TARGET_TIMEZONE: "UTC",
            TARGETS_LOCAL: "06:00",
        };
        // Use a system time guaranteed far outside any target's horizon so this
        // is deterministic regardless of when the suite runs.
        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.UTC(2026, 5, 15, 14, 0)));
        try {
            const ctx = createExecutionContext();
            const res = await worker.fetch(
                new Request("https://example.com/run", {
                    method: "POST",
                    headers: { authorization: "Bearer s3cret" },
                }),
                withSecretEnv,
                ctx
            );
            await waitOnExecutionContext(ctx);
            expect(res.status).toBe(200);
            const body = await res.json<{ action: string; reason: string }>();
            expect(body.action).toBe("skipped");
            expect(body.reason).toBe("no-target");
        } finally {
            vi.useRealTimers();
        }
    });
});
