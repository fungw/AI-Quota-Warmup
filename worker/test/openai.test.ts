import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { attemptGptWarmup, pingGpt } from "../src/openai";
import { fakeSleep, jsonResponse, makeEnv, queuedFetch, textResponse } from "./helpers";

const baseEnv = () => makeEnv({ WARMUP_STATE: env.WARMUP_STATE, OPENAI_API_KEY: "test-openai-key" });

describe("OpenAI warm-up", () => {
    it("calls the Responses API with an API key and a minimal non-stored response", async () => {
        let url: string | URL | Request | undefined;
        let init: RequestInit | undefined;
        const fetchImpl = async (nextUrl: string | URL | Request, nextInit?: RequestInit) => {
            url = nextUrl;
            init = nextInit;
            return jsonResponse({ output_text: "Warmed up!", usage: { input_tokens: 3 } });
        };
        const { log, reply } = await attemptGptWarmup(baseEnv(), "hello", 1, false, fetchImpl);
        expect(url).toBe("https://api.openai.com/v1/responses");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-openai-key");
        expect(JSON.parse(init?.body as string)).toEqual({ model: "gpt-5.2", input: "hello", max_output_tokens: 64, store: false });
        expect(reply).toBe("Warmed up!");
        expect(log.usage).toEqual({ input_tokens: 3 });
    });

    it("uses GPT_MODEL and extracts text from the output array", async () => {
        let body: Record<string, unknown> | undefined;
        const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
            body = JSON.parse(init?.body as string);
            return jsonResponse({ output: [{ content: [{ type: "output_text", text: "ok" }] }] });
        };
        const { reply } = await attemptGptWarmup({ ...baseEnv(), GPT_MODEL: "my-model" }, "hello", 1, false, fetchImpl);
        expect(body?.model).toBe("my-model");
        expect(reply).toBe("ok");
    });

    it("falls back cleanly for an empty response and captures OpenAI rate-limit headers", async () => {
        const { log, reply } = await attemptGptWarmup(baseEnv(), "hello", 1, false, queuedFetch([
            jsonResponse({}, { headers: { "x-ratelimit-remaining-requests": "99", "x-request-id": "req_123" } }),
        ]));
        expect(reply).toBe("(no text output)");
        expect(log.headers).toEqual({ "x-ratelimit-remaining-requests": "99", "x-request-id": "req_123" });
        const noText = await attemptGptWarmup(baseEnv(), "hello", 1, false, queuedFetch([
            jsonResponse({ output: [{ content: [{ type: "output_text" }] }, {}] }),
        ]));
        expect(noText.reply).toBe("(no text output)");
    });

    it("logs successful attempts in verbose mode and captures thrown fetch errors", async () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        await attemptGptWarmup(baseEnv(), "hello", 1, true, queuedFetch([jsonResponse({ output_text: "ok" })]));
        const thrown = await attemptGptWarmup(baseEnv(), "hello", 1, false, async () => { throw new TypeError("offline"); });
        expect(thrown.log.error).toEqual({ name: "TypeError", message: "offline" });
        expect(spy.mock.calls.map(([line]) => JSON.parse(line as string).event)).toContain("attempt.ok");
        spy.mockRestore();
    });

    it("captures non-Error throws and its default fetch is protected by the test guard", async () => {
        const raw = await attemptGptWarmup(baseEnv(), "hello", 1, false, async () => { throw "offline"; });
        expect(raw.log.error?.message).toBe("offline");
        const guarded = await attemptGptWarmup(baseEnv(), "hello", 1, false);
        expect(guarded.log.error?.message).toMatch(/Unexpected real fetch/);
    });

    it("retries a rate limit response and honors retry-after", async () => {
        const { sleep, calls } = fakeSleep();
        const result = await pingGpt(baseEnv(), false, {
            fetchImpl: queuedFetch([textResponse("slow", { status: 429, headers: { "retry-after": "2" } }), jsonResponse({ output_text: "ok" })]),
            sleep,
        });
        expect(result.success).toBe(true);
        expect(calls).toEqual([2000]);
    });

    it("returns API errors without retrying non-retryable statuses", async () => {
        const result = await pingGpt(baseEnv(), false, { fetchImpl: queuedFetch([textResponse("bad", { status: 401 })]) });
        expect(result).toMatchObject({ success: false, error: "bad" });
    });

    it("uses the default warm-up text when WARMUP_MESSAGE is empty", async () => {
        let body: Record<string, unknown> | undefined;
        await pingGpt({ ...baseEnv(), WARMUP_MESSAGE: "" }, false, {
            fetchImpl: async (_url, init) => { body = JSON.parse(init?.body as string); return jsonResponse({ output_text: "ok" }); },
        });
        expect(body?.input).toMatch(/Warmed up/);
    });

    it("uses exponential retry and the default sleeper when retry-after is absent", async () => {
        vi.useFakeTimers();
        try {
            const result = pingGpt(baseEnv(), false, {
                fetchImpl: queuedFetch([textResponse("busy", { status: 500 }), jsonResponse({ output_text: "ok" })]),
            });
            await vi.advanceTimersByTimeAsync(1000);
            expect((await result).success).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("uses default dependencies when none are supplied", async () => {
        const fetchStub = vi.fn(async () => jsonResponse({ output_text: "ok" }));
        vi.stubGlobal("fetch", fetchStub);
        try {
            expect((await pingGpt(baseEnv(), false)).success).toBe(true);
            expect(fetchStub).toHaveBeenCalledOnce();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("returns a captured network error after retries", async () => {
        const { sleep } = fakeSleep();
        const result = await pingGpt(baseEnv(), false, {
            fetchImpl: async () => { throw new TypeError("offline"); }, sleep,
        });
        expect(result).toMatchObject({ success: false, error: "offline" });
    });
});
