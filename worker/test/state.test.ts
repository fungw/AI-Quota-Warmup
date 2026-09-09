import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_STATE, LEGACY_STATE_KEY, readState, STATE_KEY, writeState, type State } from "../src/state";
import { makeEnv } from "./helpers";

describe("readState / writeState", () => {
    beforeEach(async () => {
        await env.WARMUP_STATE.delete(STATE_KEY);
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
        const state: State = { ...EMPTY_STATE, firedTarget: "legacy" };
        await env.WARMUP_STATE.put(LEGACY_STATE_KEY, JSON.stringify(state));
        const testEnv = makeEnv({ WARMUP_STATE: env.WARMUP_STATE });
        expect(await readState(testEnv)).toEqual(state);
        expect(await env.WARMUP_STATE.get(STATE_KEY, "json")).toEqual(state);
    });
});
