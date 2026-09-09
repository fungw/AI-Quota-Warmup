import type { Env, WarmupProvider } from "./config";
import { resolveConfig } from "./config";
import { currentTarget } from "./schedule";
import { readState, writeState, type State } from "./state";
import { ANTHROPIC_API_URL, MODEL, resetFromHeaders, ping, type PingDeps } from "./anthropic";
import { DEFAULT_GPT_MODEL, OPENAI_API_URL, pingGpt } from "./openai";
import { emit, fingerprint } from "./log";

export type SkipReason = "no-target" | "already-served" | "window-still-open";

export interface TickOptions {
    trigger: "cron" | "manual";
    cron: string | null;
    scheduledTime: number | null;
    force?: boolean;
}

export interface TickDeps extends PingDeps {
    now?: () => Date;
}

type ClockBase = {
    runId: string;
    trigger: TickOptions["trigger"];
    cron: string | null;
    scheduledAt: string | null;
    startedAt: string;
    driftMs: number | null;
    targetSlot: string | null;
    minutesSinceTarget: number | null;
};

export type ProviderReport = ClockBase & {
    provider: WarmupProvider;
    action: "skipped" | "pinged";
    success: boolean;
    reason?: SkipReason;
    knownResetAt?: string | null;
    minutesUntilReset?: number | null;
    firedTarget?: string | null;
    url?: string;
    model?: string;
    forced?: boolean;
    tokenFingerprint?: string;
    finishedAt?: string;
    totalMs?: number;
    attempts?: unknown[];
    reply?: string;
    error?: string;
    newResetAt?: string | null;
    newResetSource?: string | null;
    rateLimit?: Record<string, string>;
};

type AggregateReport = ClockBase & {
    action: "aggregate";
    success: boolean;
    results: ProviderReport[];
};

function providerSettings(env: Env, provider: WarmupProvider) {
    const isOpenAi = provider === "openai";
    return {
        apiUrl: isOpenAi ? OPENAI_API_URL : ANTHROPIC_API_URL,
        model: isOpenAi ? env.GPT_MODEL || DEFAULT_GPT_MODEL : MODEL,
        token: isOpenAi ? env.OPENAI_API_KEY : env.CLAUDE_CODE_OAUTH_TOKEN,
        missingSecret: isOpenAi ? "OPENAI_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN",
    };
}

async function runProvider(
    env: Env,
    provider: WarmupProvider,
    base: ClockBase,
    target: Date | null,
    started: Date,
    opts: TickOptions,
    deps: TickDeps,
    now: () => Date,
    verbose: boolean,
): Promise<ProviderReport> {
    if (!opts.force && !target) {
        const reportBase = { ...base, provider } as ProviderReport;
        if (verbose) emit("run.skipped", { ...reportBase, reason: "no-target" });
        return { ...reportBase, action: "skipped", reason: "no-target", success: true };
    }
    const state = await readState(env, provider);
    const settings = providerSettings(env, provider);
    const stateFields = {
        knownResetAt: state.nextResetAt === null ? null : new Date(state.nextResetAt).toISOString(),
        minutesUntilReset:
            state.nextResetAt === null ? null : Math.round((state.nextResetAt - started.getTime()) / 60_000),
        firedTarget: state.firedTarget,
    };
    const reportBase = { ...base, ...stateFields, provider } as ProviderReport;

    const skip = (reason: SkipReason): ProviderReport => {
        emit("run.skipped", { ...reportBase, reason });
        return { ...reportBase, action: "skipped", reason, success: true };
    };

    if (!opts.force && state.firedTarget === target?.toISOString()) return skip("already-served");
    // Only Claude has a documented five-hour session boundary. OpenAI's
    // request/token buckets must not be mistaken for one.
    if (!opts.force && provider === "claude" && state.nextResetAt !== null && started.getTime() < state.nextResetAt) {
        return skip("window-still-open");
    }

    const settingsForLog = {
        forced: Boolean(opts.force),
        url: settings.apiUrl,
        model: settings.model,
        tokenFingerprint: fingerprint(settings.token),
    };
    emit("run.start", { ...reportBase, ...settingsForLog });

    if (!settings.token) {
        const finished = now();
        await writeState(env, {
            ...state,
            lastPingAt: finished.toISOString(),
            lastOutcome: "failure",
        } satisfies State, provider);
        const report: ProviderReport = {
            ...reportBase,
            ...settingsForLog,
            action: "pinged",
            success: false,
            error: `${settings.missingSecret} is not set. Run \`wrangler secret put ${settings.missingSecret}\`.`,
        };
        emit("run.failure", report);
        return report;
    }

    const result = provider === "openai" ? await pingGpt(env, verbose, deps) : await ping(env, verbose, deps);
    const finished = now();
    const reset = result.success
        ? provider === "openai"
            ? null
            : resetFromHeaders(result.headers, finished.getTime())
        : null;

    if (result.success) {
        await writeState(
            env,
            {
                nextResetAt: reset?.at ?? null,
                firedTarget: target?.toISOString() ?? state.firedTarget,
                lastPingAt: finished.toISOString(),
                lastOutcome: "success",
            } satisfies State,
            provider,
        );
    } else {
        await writeState(
            env,
            { ...state, lastPingAt: finished.toISOString(), lastOutcome: "failure" } satisfies State,
            provider,
        );
    }

    const report: ProviderReport = {
        ...reportBase,
        ...settingsForLog,
        action: "pinged",
        finishedAt: finished.toISOString(),
        totalMs: finished.getTime() - started.getTime(),
        success: result.success,
        attempts: result.attempts,
        reply: result.success ? result.reply : undefined,
        error: result.success ? undefined : result.error,
        newResetAt: reset ? new Date(reset.at).toISOString() : null,
        newResetSource: reset?.source ?? (provider === "openai" && result.success ? "provider:no-session-window" : null),
        rateLimit: result.success ? result.headers : undefined,
    };
    emit(result.success ? "run.success" : "run.failure", report);
    return report;
}

export async function tick(env: Env, opts: TickOptions, deps: TickDeps = {}) {
    const now = deps.now ?? (() => new Date());
    const runId = crypto.randomUUID();
    const started = now();
    const configResult = resolveConfig(env);
    const clockBase = {
        runId,
        trigger: opts.trigger,
        cron: opts.cron,
        scheduledAt: opts.scheduledTime === null ? null : new Date(opts.scheduledTime).toISOString(),
        startedAt: started.toISOString(),
        driftMs: opts.scheduledTime === null ? null : started.getTime() - opts.scheduledTime,
    };

    if (!configResult.ok) {
        const report = {
            ...clockBase,
            targetSlot: null,
            minutesSinceTarget: null,
            action: "failed" as const,
            success: false,
            error: `Invalid configuration: ${configResult.error}`,
        };
        emit("run.failure", report);
        return report;
    }

    const { config } = configResult;
    const target = currentTarget(started, config.targets, config.timeZone, config.horizonMs);
    const base: ClockBase = {
        ...clockBase,
        targetSlot: target?.toISOString() ?? null,
        minutesSinceTarget: target ? Math.round((started.getTime() - target.getTime()) / 60_000) : null,
    };

    if (!opts.force && !target && config.providers.length === 1) {
        if (config.verbose) emit("run.skipped", { ...base, provider: config.provider, reason: "no-target" });
        return { ...base, action: "skipped" as const, reason: "no-target" as const, success: true };
    }

    const results = await Promise.all(
        config.providers.map((provider) =>
            runProvider(env, provider, base, target, started, opts, deps, now, config.verbose),
        ),
    );
    if (config.providers.length === 1) return results[0];

    const report: AggregateReport = {
        ...base,
        action: "aggregate",
        success: results.every((result) => result.success),
        results,
    };
    emit(report.success ? "run.success" : "run.failure", report);
    return report;
}
