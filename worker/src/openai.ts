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

export const OPENAI_API_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_GPT_MODEL = "gpt-5.2";
export const DEFAULT_GPT_WARMUP_MESSAGE = "Reply with exactly: Warmed up!";

const realSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pickHeaders(res: Response): Record<string, string> {
    const out: Record<string, string> = {};
    res.headers.forEach((value, name) => {
        if (name.startsWith("x-ratelimit-") || name === "x-request-id" || name === "retry-after") out[name] = value;
    });
    return out;
}

function outputText(data: { output_text?: unknown; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }): string {
    if (typeof data.output_text === "string") return data.output_text;
    return data.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text ?? "(no text output)";
}

export async function attemptGptWarmup(
    env: Env, message: string, attempt: number, verbose: boolean, fetchImpl: FetchImpl = fetch
): Promise<{ log: AttemptLog; reply?: string }> {
    const startedAt = new Date();
    const t0 = Date.now();
    const model = env.GPT_MODEL || DEFAULT_GPT_MODEL;
    if (verbose) emit("attempt.start", { attempt, url: OPENAI_API_URL, model, messageChars: message.length });
    try {
        const response = await fetchImpl(OPENAI_API_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model, input: message, max_output_tokens: 64, store: false }),
            signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });
        const headers = pickHeaders(response);
        if (!response.ok) {
            const log: AttemptLog = { attempt, startedAt: startedAt.toISOString(), durationMs: Date.now() - t0,
                status: response.status, statusText: response.statusText, ok: false, headers, errorBody: truncate(await response.text()) };
            emit("attempt.failed", log);
            return { log };
        }
        const data = (await response.json()) as { output_text?: unknown; output?: Array<{ content?: Array<{ type?: string; text?: string }> }>; usage?: unknown };
        const log: AttemptLog = { attempt, startedAt: startedAt.toISOString(), durationMs: Date.now() - t0,
            status: response.status, statusText: response.statusText, ok: true, headers, usage: data.usage };
        const reply = outputText(data);
        if (verbose) emit("attempt.ok", { ...log, reply });
        return { log, reply };
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const log: AttemptLog = { attempt, startedAt: startedAt.toISOString(), durationMs: Date.now() - t0, ok: false,
            error: { name: error.name, message: error.message } };
        emit("attempt.error", log);
        return { log };
    }
}

export async function pingGpt(env: Env, verbose: boolean, deps: { fetchImpl?: FetchImpl; sleep?: SleepImpl } = {}) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const sleep = deps.sleep ?? realSleep;
    const message = env.WARMUP_MESSAGE || DEFAULT_GPT_WARMUP_MESSAGE;
    const attempts: AttemptLog[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { log, reply } = await attemptGptWarmup(env, message, attempt, verbose, fetchImpl);
        attempts.push(log);
        // attemptGptWarmup always supplies headers for a successful HTTP response.
        if (log.ok) return { success: true as const, attempts, reply, headers: log.headers! };
        if (!isRetryable(log.status) || attempt === MAX_ATTEMPTS) {
            if (log.errorBody) return { success: false as const, attempts, error: log.errorBody };
            /* istanbul ignore else -- failed attempts always carry an Error when no HTTP body exists. */
            if (log.error) return { success: false as const, attempts, error: log.error.message };
            /* istanbul ignore next -- failed attempts always have errorBody or error. */
            return {
                success: false as const,
                attempts,
                error: `HTTP ${log.status ?? "?"}`,
            };
        }
        const retryAfter = Number(log.headers?.["retry-after"]);
        const requestedMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
        const backoffMs = Math.min(requestedMs, MAX_BACKOFF_MS);
        emit("attempt.retrying", { attempt, backoffMs, requestedMs });
        await sleep(backoffMs);
    }
    /* istanbul ignore next -- MAX_ATTEMPTS is positive and the final loop pass returns above. */
    return { success: false as const, attempts, error: "exhausted attempts" };
}
