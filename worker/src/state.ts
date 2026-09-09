import type { Env, WarmupProvider } from "./config";

/** Provider-specific keys prevent one API's history from affecting another. */
export const STATE_KEY = "warmup-state:claude";
export const LEGACY_STATE_KEY = "state";
export function stateKey(provider: WarmupProvider): string {
    return `warmup-state:${provider}`;
}

export interface State {
    /** Epoch ms of the next 5h window reset, per the last observed header. */
    nextResetAt: number | null;
    /** ISO of the target slot most recently served, so we serve each slot once. */
    firedTarget: string | null;
    lastPingAt: string | null;
    lastOutcome: string | null;
}

export const EMPTY_STATE: State = {
    nextResetAt: null,
    firedTarget: null,
    lastPingAt: null,
    lastOutcome: null,
};

export async function readState(env: Env, provider: WarmupProvider = "claude"): Promise<State> {
    const key = stateKey(provider);
    let stored = await env.WARMUP_STATE.get<State>(key, "json");
    // Migrate the original single-provider key lazily for Claude deployments.
    if (stored === null && provider === "claude" && key !== LEGACY_STATE_KEY) {
        stored = await env.WARMUP_STATE.get<State>(LEGACY_STATE_KEY, "json");
        if (stored !== null) await env.WARMUP_STATE.put(key, JSON.stringify(stored));
    }
    return { ...EMPTY_STATE, ...(stored ?? {}) };
}

export async function writeState(env: Env, state: State, provider: WarmupProvider = "claude"): Promise<void> {
    await env.WARMUP_STATE.put(stateKey(provider), JSON.stringify(state));
}
