import assert from "node:assert/strict";
import test from "node:test";
import {
    hasOpenWindow,
    nextResetAt,
    normalizeRateLimits,
    performWarmup,
    secureEqual,
} from "../server.mjs";

test("constant-time credential comparison matches only equal values", () => {
    assert.equal(secureEqual("Bearer same", "Bearer same"), true);
    assert.equal(secureEqual("Bearer wrong", "Bearer same"), false);
});

test("normalizes the Codex bucket and converts its reset timestamp", () => {
    const limits = normalizeRateLimits({
        rateLimitsByLimitId: {
            codex: {
                limitId: "codex",
                planType: "plus",
                primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 2_000 },
                secondary: null,
            },
        },
    });
    assert.deepEqual(limits, {
        limitId: "codex",
        planType: "plus",
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 2_000 },
        secondary: null,
    });
    assert.equal(nextResetAt(limits), 2_000_000);
    assert.equal(hasOpenWindow(limits, 1_000_000), true);
    assert.equal(hasOpenWindow(limits, 2_000_000), false);
});

test("skips an open window without invoking Codex or caching the skip", async () => {
    let executions = 0;
    let saves = 0;
    const result = await performWarmup(
        { message: "warm", idempotencyKey: "slot", force: false },
        {
            now: () => 1_000_000,
            load: async () => ({}),
            save: async () => { saves += 1; },
            execute: async () => { executions += 1; return "Warmed up!"; },
            readLimits: async () => ({
                limitId: "codex",
                planType: "plus",
                primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 2_000 },
                secondary: null,
            }),
        },
    );
    assert.equal(result.action, "skipped");
    assert.equal(executions, 0);
    assert.equal(saves, 0);
});

test("runs Codex, records the authoritative reset, and replays idempotently", async () => {
    let executions = 0;
    let stored = {};
    const deps = {
        now: () => 1_000_000,
        load: async () => stored,
        save: async (next) => { stored = structuredClone(next); },
        execute: async () => { executions += 1; return "Warmed up!"; },
        readLimits: async () => ({
            limitId: "codex",
            planType: "plus",
            primary: { usedPercent: executions ? 1 : 0, windowDurationMins: 300, resetsAt: 2_000 },
            secondary: null,
        }),
    };
    const first = await performWarmup({ message: "warm", idempotencyKey: "slot", force: false }, deps);
    const replay = await performWarmup({ message: "warm", idempotencyKey: "slot", force: false }, deps);
    assert.equal(first.action, "pinged");
    assert.equal(first.nextResetAt, 2_000_000);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(executions, 1);
});
