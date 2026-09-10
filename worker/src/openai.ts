import type { Env } from "./config";
import {
    ATTEMPT_TIMEOUT_MS,
    MAX_ATTEMPTS,
    MAX_BACKOFF_MS,
    type AttemptLog,
    type FetchImpl,
    isRetryable,
    truncate,
    type SleepImpl,
} from "./anthropic";
import { emit } from "./log";

export const DEFAULT_GPT_MODEL = "codex-subscription-default";
export const DEFAULT_GPT_WARMUP_MESSAGE = "Reply with exactly: Warmed up!";
export const GPT_RUNNER_TIMEOUT_MS = Math.max(ATTEMPT_TIMEOUT_MS, 90_000);

const realSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CodexRateWindow {
    usedPercent: number | null;
    windowDurationMins: number | null;
    resetsAt: number | null;
}

export interface CodexRateLimits {
    limitId: string | null;
    planType: string | null;
    primary: CodexRateWindow | null;
    secondary: CodexRateWindow | null;
}

export interface GptRunnerResponse {
    success: boolean;
    action: "pinged" | "skipped";
    reason?: "window-still-open";
    reply?: string;
    nextResetAt?: number | null;
    rateLimits?: CodexRateLimits | null;
    error?: string;
}

function pickHeaders(res: Response): Record<string, string> {
    const out: Record<string, string> = {};
    res.headers.forEach((value, name) => {
        if (name === "fly-request-id" || name === "retry-after" || name === "x-request-id") out[name] = value;
    });
    return out;
}

function isRunnerResponse(value: unknown): value is GptRunnerResponse {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<GptRunnerResponse>;
    return candidate.success === true && (candidate.action === "pinged" || candidate.action === "skipped");
}

export async function attemptGptWarmup(
    env: Env,
    message: string,
    idempotencyKey: string,
    force: boolean,
    attempt: number,
    verbose: boolean,
    fetchImpl: FetchImpl = fetch,
): Promise<{ log: AttemptLog; runner?: GptRunnerResponse }> {
    const startedAt = new Date();
    const t0 = Date.now();
    const url = env.GPT_WARMUP_URL ?? "";
    if (verbose) emit("attempt.start", { attempt, url, model: DEFAULT_GPT_MODEL, messageChars: message.length });

    try {
        const response = await fetchImpl(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${env.GPT_WARMUP_SECRET}`,
                "Content-Type": "application/json",
                "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({ message, targetSlot: idempotencyKey, force }),
            signal: AbortSignal.timeout(GPT_RUNNER_TIMEOUT_MS),
        });
        const headers = pickHeaders(response);
        const raw = await response.text();

        if (!response.ok) {
            const log: AttemptLog = {
                attempt,
                startedAt: startedAt.toISOString(),
                durationMs: Date.now() - t0,
                status: response.status,
                statusText: response.statusText,
                ok: false,
                headers,
                errorBody: truncate(raw),
            };
            emit("attempt.failed", log);
            return { log };
        }

        let data: unknown;
        try {
            data = JSON.parse(raw);
        } catch {
            data = null;
        }
        if (!isRunnerResponse(data)) {
            const log: AttemptLog = {
                attempt,
                startedAt: startedAt.toISOString(),
                durationMs: Date.now() - t0,
                status: response.status,
                statusText: response.statusText,
                ok: false,
                headers,
                errorBody: truncate(`Invalid Fly runner response: ${raw}`),
            };
            emit("attempt.failed", log);
            return { log };
        }

        const log: AttemptLog = {
            attempt,
            startedAt: startedAt.toISOString(),
            durationMs: Date.now() - t0,
            status: response.status,
            statusText: response.statusText,
            ok: true,
            headers,
            usage: data.rateLimits,
        };
        if (verbose) emit("attempt.ok", { ...log, action: data.action, reply: data.reply });
        return { log, runner: data };
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const log: AttemptLog = {
            attempt,
            startedAt: startedAt.toISOString(),
            durationMs: Date.now() - t0,
            ok: false,
            error: { name: error.name, message: error.message },
        };
        emit("attempt.error", log);
        return { log };
    }
}

export async function pingGpt(
    env: Env,
    verbose: boolean,
    options: { idempotencyKey: string; force: boolean },
    deps: { fetchImpl?: FetchImpl; sleep?: SleepImpl } = {},
) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const sleep = deps.sleep ?? realSleep;
    const message = env.WARMUP_MESSAGE || DEFAULT_GPT_WARMUP_MESSAGE;
    const attempts: AttemptLog[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { log, runner } = await attemptGptWarmup(
            env,
            message,
            options.idempotencyKey,
            options.force,
            attempt,
            verbose,
            fetchImpl,
        );
        attempts.push(log);
        if (log.ok && runner) return { ...runner, attempts };
        if (!isRetryable(log.status) || attempt === MAX_ATTEMPTS) {
            if (log.errorBody) return { success: false as const, attempts, error: log.errorBody };
            if (log.error) return { success: false as const, attempts, error: log.error.message };
            return { success: false as const, attempts, error: `HTTP ${log.status ?? "?"}` };
        }
        const retryAfter = Number(log.headers?.["retry-after"]);
        const requestedMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 1000 * 2 ** (attempt - 1);
        const backoffMs = Math.min(requestedMs, MAX_BACKOFF_MS);
        emit("attempt.retrying", { attempt, backoffMs, requestedMs });
        await sleep(backoffMs);
    }
    /* istanbul ignore next -- MAX_ATTEMPTS is positive and the final loop pass returns above. */
    return { success: false as const, attempts, error: "exhausted attempts" };
}
