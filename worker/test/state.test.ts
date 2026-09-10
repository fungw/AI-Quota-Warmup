import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_STATE, LEGACY_STATE_KEY, readState, STATE_KEY, writeState, type State } from "../src/state";
import { makeEnv } from "./helpers";

describe("readState / writeState", () => {
    beforeEach(async () => {
        await env.WARMUP_STATE.delete(STATE_KEY);
        await env.WARMUP_STATE.delete(LEGACY_STATE_KEY);
    });

    it("returns EMPTY_STATE when the key is absent (E1)", async () => {
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE });
        expect(await readState(testEnv)).toEqual(EMPTY_STATE);
    });

    it("merges a partial stored value over EMPTY_STATE (E2)", async () => {
        await env.WARMUP_STATE.put(STATE_KEY, JSON.stringify({ nextResetAt: 1 }));
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE });
        expect(await readState(testEnv)).toEqual({ ...EMPTY_STATE, nextResetAt: 1 });
    });

    it("round-trips a full state object (E3)", async () => {
        const full: State = {
            nextResetAt: 12345,
            firedTarget: "2026-06-15T06:00:00.000Z",
            lastPingAt: "2026-06-15T06:00:05.000Z",
            lastOutcome: "success",
        };
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE });
        await writeState(testEnv, full);
        expect(await readState(testEnv)).toEqual(full);
    });

    it("treats a stored null as EMPTY_STATE (E4)", async () => {
        // KV can't literally store `null` as JSON via put(), so this exercises
        // the `stored ?? {}` branch via a namespace whose get() we control.
        const nullReturningKv = {
            get: async () => null,
        } as unknown as KVNamespace;
        const testEnv = makeEnv({ WARMUP_STATE: nullReturningKv });
        expect(await readState(testEnv)).toEqual(EMPTY_STATE);
    });

    it("write then read via the real KV binding round-trips identically (E5)", async () => {
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE });
        const state: State = { nextResetAt: 999, firedTarget: null, lastPingAt: null, lastOutcome: "failure" };
        await writeState(testEnv, state);
        const reread = await readState(testEnv);
        expect(reread).toEqual(state);
    });

    it("lazily migrates the legacy Claude state key", async () => {
        const state: State = {
            ...EMPTY_STATE,
            firedTarget: "legacy",
            lastPingAt: "2026-09-10T06:00:00.000Z",
            lastOutcome: "success",
        };
        await env.WARMUP_STATE.put(LEGACY_STATE_KEY, JSON.stringify(state));
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE });
        expect(await readState(testEnv)).toEqual(state);
        expect(await env.WARMUP_STATE.get(STATE_KEY, "json")).toEqual(state);
    });

    it("reconciles legacy safety fields when a stale provider key already exists", async () => {
        const current: State = {
            nextResetAt: Date.parse("2026-09-09T15:00:00.000Z"),
            firedTarget: "2026-09-09T10:00:00.000Z",
            lastPingAt: "2026-09-10T08:40:18.000Z",
            lastOutcome: "failure",
        };
        const legacy: State = {
            nextResetAt: Date.parse("2026-09-10T10:00:00.000Z"),
            firedTarget: "2026-09-10T05:00:00.000Z",
            lastPingAt: "2026-09-10T05:00:25.000Z",
            lastOutcome: "success",
        };
        await env.WARMUP_STATE.put(STATE_KEY, JSON.stringify(current));
        await env.WARMUP_STATE.put(LEGACY_STATE_KEY, JSON.stringify(legacy));

        const expected: State = {
            nextResetAt: legacy.nextResetAt,
            firedTarget: legacy.firedTarget,
            lastPingAt: current.lastPingAt,
            lastOutcome: current.lastOutcome,
        };
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE });
        expect(await readState(testEnv)).toEqual(expected);
        expect(await env.WARMUP_STATE.get(STATE_KEY, "json")).toEqual(expected);
    });

    it("keeps current gating fields when the legacy state has null or older values", async () => {
        const current: State = {
            nextResetAt: 200,
            firedTarget: "2026-09-10T10:00:00.000Z",
            lastPingAt: "2026-09-10T10:01:00.000Z",
            lastOutcome: "success",
        };
        const legacy: State = {
            nextResetAt: null,
            firedTarget: null,
            lastPingAt: null,
            lastOutcome: "failure",
        };
        await env.WARMUP_STATE.put(STATE_KEY, JSON.stringify(current));
        await env.WARMUP_STATE.put(LEGACY_STATE_KEY, JSON.stringify(legacy));

        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE });
        expect(await readState(testEnv)).toEqual(current);
    });

    it("handles invalid legacy timestamps conservatively", async () => {
        const current: State = {
            nextResetAt: null,
            firedTarget: "invalid-current",
            lastPingAt: "2026-09-10T09:00:00.000Z",
            lastOutcome: "failure",
        };
        const legacy: State = {
            nextResetAt: 300,
            firedTarget: "2026-09-10T10:00:00.000Z",
            lastPingAt: "invalid-legacy",
            lastOutcome: "success",
        };
        await env.WARMUP_STATE.put(STATE_KEY, JSON.stringify(current));
        await env.WARMUP_STATE.put(LEGACY_STATE_KEY, JSON.stringify(legacy));

        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE });
        expect(await readState(testEnv)).toEqual({
            nextResetAt: 300,
            firedTarget: legacy.firedTarget,
            lastPingAt: current.lastPingAt,
            lastOutcome: current.lastOutcome,
        });
    });

    it("does not rewrite an already reconciled provider key", async () => {
        const state: State = {
            nextResetAt: 300,
            firedTarget: "invalid",
            lastPingAt: "invalid",
            lastOutcome: "success",
        };
        let writes = 0;
        const kv = {
            get: (key: string) => Promise.resolve(key === STATE_KEY ? state : state),
            put: () => {
                writes++;
                return Promise.resolve();
            },
        } as unknown as KVNamespace;
        expect(await readState(makeEnv({ WARMUP_STATE: kv }))).toEqual(state);
        expect(writes).toBe(0);
    });
});
