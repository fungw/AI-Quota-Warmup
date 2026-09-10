import { emit } from "./log";
import type { Target } from "./schedule";

export const DEFAULT_TARGETS = "06:00,11:00,16:00,21:00";
/** IANA zone. Ireland's "Irish Standard Time" is the UTC+1 summer clock; winter reverts to GMT (UTC+0). */
export const DEFAULT_TIMEZONE = "Europe/Dublin";
/** How long after a target we keep retrying before giving that slot up. Must be < the gap between targets. */
export const DEFAULT_HORIZON_MINUTES = 240;

export interface Env {
    WARMUP_STATE: KVNamespace;
    CLAUDE_CODE_OAUTH_TOKEN: string;
    /** Comma-separated APIs to warm: `claude`, `openai`, or both. */
    WARMUP_PROVIDERS?: string;
    /** Deprecated compatibility alias for a single provider. */
    WARMUP_PROVIDER?: string;
    /** HTTPS endpoint for the subscription-authenticated Codex runner on Fly.io. */
    GPT_WARMUP_URL?: string;
    /** Shared bearer secret for Worker -> Fly runner authentication. */
    GPT_WARMUP_SECRET?: string;
    WARMUP_MESSAGE?: string;
    /** Comma-separated local wall-clock times, e.g. "06:00,11:00,16:00,21:00". */
    TARGETS_LOCAL?: string;
    /** IANA zone the targets above are interpreted in, e.g. "Europe/Dublin". */
    TARGET_TIMEZONE?: string;
    CATCHUP_HORIZON_MINUTES?: string;
    /** Optional. When set, enables the manual POST /run trigger. */
    DEBUG_TRIGGER_SECRET?: string;
    VERBOSE?: string;
}

export function parseTargets(raw: string): Target[] {
    const targets: Target[] = [];
    for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const [h, m = "0"] = trimmed.split(":");
        const hours = Number(h);
        const minutes = Number(m);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
            throw new Error(`Invalid entry "${trimmed}" in TARGETS_LOCAL`);
        }
        targets.push({ hours, minutes });
    }
    if (targets.length === 0) throw new Error("TARGETS_LOCAL is empty");
    return targets.sort((a, b) => a.hours * 60 + a.minutes - (b.hours * 60 + b.minutes));
}

/**
 * Bug fix: `Number(raw ?? DEFAULT)` only falls back on `undefined`/`null`, so
 * an empty string parsed to 0 and a typo like "240m" parsed to NaN — both
 * silently produced a horizon that can never match, meaning the Worker stops
 * pinging forever with nothing but a routine-looking `no-target` log to show
 * for it. A non-finite or non-positive value now falls back explicitly, with
 * a logged warning so a bad deploy is visible instead of silent.
 */
export function resolveHorizonMinutes(raw: string | undefined): number {
    if (raw === undefined) return DEFAULT_HORIZON_MINUTES;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        emit("config.invalid", { field: "CATCHUP_HORIZON_MINUTES", raw, fallback: DEFAULT_HORIZON_MINUTES });
        return DEFAULT_HORIZON_MINUTES;
    }
    return parsed;
}

export interface ResolvedConfig {
    timeZone: string;
    targets: Target[];
    horizonMinutes: number;
    horizonMs: number;
    verbose: boolean;
    /** Enabled providers, in the order configured. */
    providers: WarmupProvider[];
    /** First provider, retained for callers that only support one provider. */
    provider: WarmupProvider;
}

export type WarmupProvider = "claude" | "openai";

export type ConfigResult = { ok: true; config: ResolvedConfig } | { ok: false; error: string };

/**
 * Bug fix: `parseTargets` used to throw straight out of both the `scheduled`
 * and `fetch` handlers on a bad `TARGETS_LOCAL` — an opaque 500 from `/health`,
 * and an unhandled rejection inside `ctx.waitUntil` from the cron path, with no
 * application-level log line either way. Resolving config into a result object
 * lets both call sites report the failure through the normal `emit` channel
 * instead of crashing.
 */
export function resolveConfig(env: Env): ConfigResult {
    const timeZone = env.TARGET_TIMEZONE || DEFAULT_TIMEZONE;
    const verbose = env.VERBOSE !== "false";
    const horizonMinutes = resolveHorizonMinutes(env.CATCHUP_HORIZON_MINUTES);
    const configuredProviders = env.WARMUP_PROVIDERS?.trim() || env.WARMUP_PROVIDER?.trim() || "claude";
    const rawProviders = configuredProviders.split(",").map((part) => part.trim()).filter(Boolean);
    if (rawProviders.length === 0) return { ok: false, error: "WARMUP_PROVIDERS is empty" };
    const unknown = rawProviders.find((provider) => provider !== "claude" && provider !== "openai");
    if (unknown) {
        /* istanbul ignore next -- both names are covered by the returned validation error. */
        const field = env.WARMUP_PROVIDERS?.trim() ? "WARMUP_PROVIDERS" : "WARMUP_PROVIDER";
        return { ok: false, error: `Invalid ${field} "${unknown}"; expected "claude" or "openai"` };
    }
    const providers = rawProviders as WarmupProvider[];
    if (new Set(providers).size !== providers.length) {
        return { ok: false, error: `Duplicate provider in WARMUP_PROVIDERS "${configuredProviders}"` };
    }
    if (env.WARMUP_PROVIDERS?.trim() && env.WARMUP_PROVIDER?.trim() && env.WARMUP_PROVIDERS.trim() !== env.WARMUP_PROVIDER.trim()) {
        return { ok: false, error: "WARMUP_PROVIDERS and deprecated WARMUP_PROVIDER disagree" };
    }
    try {
        const targets = parseTargets(env.TARGETS_LOCAL || DEFAULT_TARGETS);
        return {
            ok: true,
            config: {
                timeZone,
                targets,
                horizonMinutes,
                horizonMs: horizonMinutes * 60_000,
                verbose,
                providers,
                provider: providers[0],
            },
        };
    } catch (err) {
        // istanbul ignore next -- parseTargets only ever throws `new Error(...)`;
        // the String(err) branch is defensive symmetry, not a reachable path.
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false, error };
    }
}
