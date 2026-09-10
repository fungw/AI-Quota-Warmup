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

function laterIso(a: string | null, b: string | null): string | null {
    if (a === null) return b;
    if (b === null) return a;
    const aTime = Date.parse(a);
    const bTime = Date.parse(b);
    if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? b : a;
    if (!Number.isFinite(bTime)) return a;
    return bTime > aTime ? b : a;
}

function isLaterIso(candidate: string | null, baseline: string | null): boolean {
    if (candidate === null) return false;
    if (baseline === null) return true;
    const candidateTime = Date.parse(candidate);
    const baselineTime = Date.parse(baseline);
    return Number.isFinite(candidateTime) && (!Number.isFinite(baselineTime) || candidateTime > baselineTime);
}

/**
 * During the single-provider to multi-provider rollout, the legacy Worker and
 * its replacement briefly shared this namespace. That can leave both keys
 * populated, with the legacy key carrying a newer successful Claude window
 * while the provider-specific key carries a later failed attempt. Preserve the
 * newest diagnostic outcome, but merge the most conservative gating fields so
 * a deployment cannot spend a duplicate request inside an already-open window.
 */
function mergeClaudeState(current: State, legacy: State): State {
    const legacyHasLaterOutcome = isLaterIso(legacy.lastPingAt, current.lastPingAt);
    return {
        nextResetAt:
            current.nextResetAt === null
                ? legacy.nextResetAt
                : legacy.nextResetAt === null
                  ? current.nextResetAt
                  : Math.max(current.nextResetAt, legacy.nextResetAt),
        firedTarget: laterIso(current.firedTarget, legacy.firedTarget),
        lastPingAt: laterIso(current.lastPingAt, legacy.lastPingAt),
        lastOutcome: legacyHasLaterOutcome ? legacy.lastOutcome : current.lastOutcome,
    };
}

export async function readState(env: Env, provider: WarmupProvider = "claude"): Promise<State> {
    const key = stateKey(provider);
    const rawStored = await env.WARMUP_STATE.get<State>(key, "json");
    let stored = { ...EMPTY_STATE, ...(rawStored ?? {}) };
    // Migrate and reconcile the original single-provider key for Claude.
    if (provider === "claude" && key !== LEGACY_STATE_KEY) {
        const rawLegacy = await env.WARMUP_STATE.get<State>(LEGACY_STATE_KEY, "json");
        if (rawLegacy !== null) {
            const merged = mergeClaudeState(stored, { ...EMPTY_STATE, ...rawLegacy });
            if (rawStored === null || JSON.stringify(merged) !== JSON.stringify(stored)) {
                await env.WARMUP_STATE.put(key, JSON.stringify(merged));
            }
            stored = merged;
        }
    }
    return stored;
}

export async function writeState(env: Env, state: State, provider: WarmupProvider = "claude"): Promise<void> {
    await env.WARMUP_STATE.put(stateKey(provider), JSON.stringify(state));
}
