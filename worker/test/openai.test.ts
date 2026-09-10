import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { attemptGptWarmup, pingGpt } from "../src/openai";
import { fakeSleep, jsonResponse, makeEnv, queuedFetch, textResponse } from "./helpers";

const RUNNER_URL = "https://ai-quota-openai.fly.dev/warmup";
const runnerResult = (overrides: Record<string, unknown> = {}) => ({
    success: true,
    action: "pinged",
    reply: "Warmed up!",
    nextResetAt: Date.UTC(2026, 5, 15, 11, 0),
    rateLimits: {
        limitId: "codex",
        planType: "plus",
        primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: Date.UTC(2026, 5, 15, 11, 0) / 1000 },
        secondary: null,
    },
    ...overrides,
});
const baseEnv = () => makeEnv({
    WARMUP_STATE: env.WARMUP_STATE,
    GPT_WARMUP_URL: RUNNER_URL,
    GPT_WARMUP_SECRET: "test-runner-secret",
});
const options = { idempotencyKey: "2026-06-15T06:00:00.000Z", force: false };

describe("OpenAI warm-up via Fly Codex runner", () => {
    it("calls the authenticated runner with an idempotency key and minimal prompt", async () => {
        let url: string | URL | Request | undefined;
        let init: RequestInit | undefined;
        const fetchImpl = async (nextUrl: string | URL | Request, nextInit?: RequestInit) => {
            url = nextUrl;
            init = nextInit;
            return jsonResponse(runnerResult());
        };
        const { log, runner } = await attemptGptWarmup(
            baseEnv(), "hello", options.idempotencyKey, false, 1, false, fetchImpl,
        );
        expect(url).toBe(RUNNER_URL);
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-runner-secret");
        expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(options.idempotencyKey);
        expect(JSON.parse(init?.body as string)).toEqual({
            message: "hello",
            targetSlot: options.idempotencyKey,
            force: false,
        });
        expect(runner?.reply).toBe("Warmed up!");
        expect(log.usage).toEqual(runner?.rateLimits);
    });

    it("accepts the runner's window-still-open response without invoking another endpoint", async () => {
        const result = await pingGpt(baseEnv(), false, options, {
            fetchImpl: queuedFetch([jsonResponse(runnerResult({ action: "skipped", reason: "window-still-open" }))]),
        });
        expect(result).toMatchObject({ success: true, action: "skipped", reason: "window-still-open" });
    });

    it("rejects a successful HTTP response with an invalid runner payload", async () => {
        const { log } = await attemptGptWarmup(
            baseEnv(), "hello", options.idempotencyKey, false, 1, false, queuedFetch([jsonResponse({ ok: true })]),
        );
        expect(log.ok).toBe(false);
        expect(log.errorBody).toMatch(/Invalid Fly runner response/);
    });

    it("rejects malformed JSON and primitive runner payloads", async () => {
        const malformed = await attemptGptWarmup(
            { ...baseEnv(), GPT_WARMUP_URL: undefined },
            "hello",
            options.idempotencyKey,
            false,
            1,
            false,
            queuedFetch([textResponse("not-json", { status: 200 })]),
        );
        const primitive = await attemptGptWarmup(
            baseEnv(), "hello", options.idempotencyKey, false, 1, false,
            queuedFetch([jsonResponse(1)]),
        );
        expect(malformed.log.errorBody).toMatch(/Invalid Fly runner response/);
        expect(primitive.log.errorBody).toMatch(/Invalid Fly runner response/);
    });

    it("logs successful attempts in verbose mode and captures thrown fetch errors", async () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        await attemptGptWarmup(
            baseEnv(), "hello", options.idempotencyKey, false, 1, true,
            queuedFetch([jsonResponse(runnerResult())]),
        );
        const thrown = await attemptGptWarmup(
            baseEnv(), "hello", options.idempotencyKey, false, 1, false,
            async () => { throw new TypeError("offline"); },
        );
        expect(thrown.log.error).toEqual({ name: "TypeError", message: "offline" });
        expect(spy.mock.calls.map(([line]) => JSON.parse(line as string).event)).toContain("attempt.ok");
        spy.mockRestore();
    });

    it("captures non-Error throws and its default fetch is protected by the test guard", async () => {
        const raw = await attemptGptWarmup(
            baseEnv(), "hello", options.idempotencyKey, false, 1, false, async () => { throw "offline"; },
        );
        expect(raw.log.error?.message).toBe("offline");
        const guarded = await attemptGptWarmup(baseEnv(), "hello", options.idempotencyKey, false, 1, false);
        expect(guarded.log.error?.message).toMatch(/Unexpected real fetch/);
    });

    it("retries a rate limit response and honors retry-after", async () => {
        const { sleep, calls } = fakeSleep();
        const result = await pingGpt(baseEnv(), false, options, {
            fetchImpl: queuedFetch([
                textResponse("slow", { status: 429, headers: { "retry-after": "2" } }),
                jsonResponse(runnerResult()),
            ]),
            sleep,
        });
        expect(result.success).toBe(true);
        expect(calls).toEqual([2000]);
    });

    it("returns runner errors without retrying non-retryable statuses", async () => {
        const result = await pingGpt(baseEnv(), false, options, {
            fetchImpl: queuedFetch([textResponse("bad", { status: 401 })]),
        });
        expect(result).toMatchObject({ success: false, error: "bad" });
    });

    it("falls back to an HTTP status when an error response has no body", async () => {
        const numeric = await pingGpt(baseEnv(), false, options, {
            fetchImpl: queuedFetch([textResponse("", { status: 400 })]),
        });
        const unknown = await pingGpt(baseEnv(), false, options, {
            fetchImpl: async () => ({
                ok: false,
                status: undefined,
                statusText: "",
                headers: new Headers(),
                text: async () => "",
            }) as unknown as Response,
        });
        expect(numeric).toMatchObject({ success: false, error: "HTTP 400" });
        expect(unknown).toMatchObject({ success: false, error: "HTTP ?" });
    });

    it("uses the default warm-up text when WARMUP_MESSAGE is empty", async () => {
        let body: Record<string, unknown> | undefined;
        await pingGpt({ ...baseEnv(), WARMUP_MESSAGE: "" }, false, options, {
            fetchImpl: async (_url, init) => {
                body = JSON.parse(init?.body as string);
                return jsonResponse(runnerResult());
            },
        });
        expect(body?.message).toMatch(/Warmed up/);
    });

    it("uses exponential retry and the default sleeper when retry-after is absent", async () => {
        vi.useFakeTimers();
        try {
            const result = pingGpt(baseEnv(), false, options, {
                fetchImpl: queuedFetch([textResponse("busy", { status: 500 }), jsonResponse(runnerResult())]),
            });
            await vi.advanceTimersByTimeAsync(1000);
            expect((await result).success).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("uses default dependencies when none are supplied", async () => {
        const fetchStub = vi.fn(async () => jsonResponse(runnerResult()));
        vi.stubGlobal("fetch", fetchStub);
        try {
            expect((await pingGpt(baseEnv(), false, options)).success).toBe(true);
            expect(fetchStub).toHaveBeenCalledOnce();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("returns a captured network error after retries", async () => {
        const { sleep } = fakeSleep();
        const result = await pingGpt(baseEnv(), false, options, {
            fetchImpl: async () => { throw new TypeError("offline"); },
            sleep,
        });
        expect(result).toMatchObject({ success: false, error: "offline" });
    });
});
