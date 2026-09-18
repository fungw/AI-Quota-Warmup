import type { Env } from "./config";
import { emit } from "./log";

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const MODEL = "claude-haiku-4-5-20251001";
export const MAX_ATTEMPTS = 3;
export const ATTEMPT_TIMEOUT_MS = 30_000;
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
/**
 * Bug fix: how much window a successful ping must buy before we accept that it
 * *opened* one. Observation says the reset is the previous ten-minute boundary
 * plus five hours, so a genuinely fresh window reports five hours minus up to
 * ten minutes of rounding minus request latency — ~4h50m in practice, never
 * below 4h45m. A ping that merely joined a window somebody else opened (Claude
 * Code's own background daemon does this overnight) reports whatever is left of
 * that window, which has always been far less. 4h45m therefore separates the
 * two without ever misreading a genuine anchor as a join.
 */
export const MIN_ANCHORED_WINDOW_MS = FIVE_HOURS_MS - 15 * 60_000;
/** Bug fix: an uncapped `Retry-After` (e.g. 3600) would stall the whole invocation sleeping. */
export const MAX_BACKOFF_MS = 60_000;
/** Bug fix: bound on how far in the future a reset header is allowed to push the window. */
export const MAX_REASONABLE_RESET_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_WARMUP_MESSAGE =
    "Hello! This is an automated warm-up message to reset my Claude Code rate limit window. Please just say 'Warmed up!' in response.";

export interface AttemptLog {
    attempt: number;
    startedAt: string;
    durationMs: number;
    status?: number;
    statusText?: string;
    ok: boolean;
    headers?: Record<string, string>;
    usage?: unknown;
    error?: { name: string; message: string };
    errorBody?: string;
}

export type FetchImpl = typeof fetch;
export type SleepImpl = (ms: number) => Promise<void>;

const realSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keep every rate-limit header the API sends, rather than a fixed allowlist —
 * the `unified-*` family was missed once already by guessing at names.
 */
export function pickHeaders(res: Response): Record<string, string> {
    const out: Record<string, string> = {};
    res.headers.forEach((value, name) => {
        if (name.startsWith("anthropic-ratelimit") || name === "request-id" || name === "retry-after") {
            out[name] = value;
        }
    });
    return out;
}

export function truncate(text: string, max = 1000): string {
    return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars total)`;
}

export function isRetryable(status: number | undefined): boolean {
    if (status === undefined) return true; // network error or timeout
    return status === 408 || status === 429 || status >= 500;
}

/**
 * The window boundary the API just told us about. Falls back to now + 5h if
 * absent, malformed, or (bug fix) outside a sane range — a header reporting
 * milliseconds instead of seconds would otherwise land ~57000 years out and
 * block every future ping forever, since the reset would never appear to pass.
 */
export function resetFromHeaders(headers: Record<string, string>, now: number): { at: number; source: string } {
    const raw = headers["anthropic-ratelimit-unified-5h-reset"];
    const seconds = Number(raw);
    if (raw !== undefined && Number.isFinite(seconds) && seconds > 0) {
        const at = seconds * 1000;
        const deltaMs = at - now;
        if (deltaMs > 0 && deltaMs <= MAX_REASONABLE_RESET_MS) {
            return { at, source: "header" };
        }
        emit("header.rejected", {
            field: "anthropic-ratelimit-unified-5h-reset",
            raw,
            now,
            reason: "outside sane range",
        });
        return { at: now + FIVE_HOURS_MS, source: "fallback:invalid-header" };
    }
    return { at: now + FIVE_HOURS_MS, source: "fallback:+5h" };
}

export async function attemptWarmup(
    env: Env,
    message: string,
    attempt: number,
    verbose: boolean,
    fetchImpl: FetchImpl = fetch
): Promise<{ log: AttemptLog; reply?: string }> {
    const startedAt = new Date();
    const t0 = Date.now();

    if (verbose) {
        emit("attempt.start", { attempt, url: ANTHROPIC_API_URL, model: MODEL, messageChars: message.length });
    }

    try {
        const response = await fetchImpl(ANTHROPIC_API_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`,
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 64,
                messages: [{ role: "user", content: message }],
            }),
            signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });

        const headers = pickHeaders(response);

        if (!response.ok) {
            const log: AttemptLog = {
                attempt,
                startedAt: startedAt.toISOString(),
                durationMs: Date.now() - t0,
                status: response.status,
                statusText: response.statusText,
                ok: false,
                headers,
                errorBody: truncate(await response.text()),
            };
            emit("attempt.failed", log);
            return { log };
        }

        const data = (await response.json()) as {
            content?: Array<{ type: string; text?: string }>;
            usage?: unknown;
        };
        const reply = data.content?.find((b) => b.type === "text")?.text ?? "(no text block)";

        const log: AttemptLog = {
            attempt,
            startedAt: startedAt.toISOString(),
            durationMs: Date.now() - t0,
            status: response.status,
            statusText: response.statusText,
            ok: true,
            headers,
            usage: data.usage,
        };
        if (verbose) emit("attempt.ok", { ...log, reply });
        return { log, reply };
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

export interface PingDeps {
    fetchImpl?: FetchImpl;
    sleep?: SleepImpl;
}

export async function ping(env: Env, verbose: boolean, deps: PingDeps = {}) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const sleep = deps.sleep ?? realSleep;
    const message = env.WARMUP_MESSAGE || DEFAULT_WARMUP_MESSAGE;
    const attempts: AttemptLog[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { log, reply } = await attemptWarmup(env, message, attempt, verbose, fetchImpl);
        attempts.push(log);

        if (log.ok) {
            // istanbul ignore next -- log.ok === true always sets headers in
            // attemptWarmup; the {} fallback is defensive, not reachable.
            return { success: true as const, attempts, reply, headers: log.headers ?? {} };
        }

        if (!isRetryable(log.status) || attempt === MAX_ATTEMPTS) {
            return {
                success: false as const,
                attempts,
                // istanbul ignore next -- log.ok === false always carries either
                // errorBody (HTTP failure) or error (thrown exception); the
                // `HTTP ${status}` tail is defensive and not otherwise reachable.
                error: /* istanbul ignore next */ log.errorBody ?? log.error?.message ?? `HTTP ${log.status ?? "?"}`,
            };
        }

        const retryAfter = Number(log.headers?.["retry-after"]);
        const requestedMs =
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
        const backoffMs = Math.min(requestedMs, MAX_BACKOFF_MS);
        emit("attempt.retrying", { attempt, backoffMs, requestedMs });
        await sleep(backoffMs);
    }

    /* istanbul ignore next -- unreachable with MAX_ATTEMPTS >= 1: the loop's last
       iteration always satisfies `attempt === MAX_ATTEMPTS` and returns above.
       Kept as a defensive fallback should that invariant ever change. */
    return { success: false as const, attempts, error: "exhausted attempts" };
}
