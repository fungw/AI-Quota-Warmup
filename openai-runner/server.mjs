import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT || 8080);
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const DATA_DIR = process.env.WARMUP_DATA_DIR || "/data";
const WORKSPACE_DIR = process.env.CODEX_WORKSPACE_DIR || "/app/workspace";
const LEDGER_PATH = join(DATA_DIR, "warmup-ledger.json");
const MAX_BODY_BYTES = 16 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const RATE_LIMIT_TIMEOUT_MS = 15_000;
const MAX_LEDGER_ENTRIES = 32;

export function secureEqual(actual, expected) {
    const actualDigest = createHash("sha256").update(actual).digest();
    const expectedDigest = createHash("sha256").update(expected).digest();
    return timingSafeEqual(actualDigest, expectedDigest);
}

function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeWindow(window) {
    if (!window || typeof window !== "object") return null;
    return {
        usedPercent: finiteNumber(window.usedPercent),
        windowDurationMins: finiteNumber(window.windowDurationMins),
        resetsAt: finiteNumber(window.resetsAt),
    };
}

export function normalizeRateLimits(result) {
    const buckets = result?.rateLimitsByLimitId;
    const bucket = buckets?.codex ?? result?.rateLimits;
    if (!bucket || typeof bucket !== "object") return null;
    return {
        limitId: typeof bucket.limitId === "string" ? bucket.limitId : null,
        planType: typeof bucket.planType === "string" ? bucket.planType : null,
        primary: normalizeWindow(bucket.primary),
        secondary: normalizeWindow(bucket.secondary),
    };
}

export function nextResetAt(rateLimits) {
    const resetSeconds = rateLimits?.primary?.resetsAt;
    return typeof resetSeconds === "number" ? resetSeconds * 1000 : null;
}

export function hasOpenWindow(rateLimits, now = Date.now()) {
    const primary = rateLimits?.primary;
    return Boolean(
        primary
        && typeof primary.usedPercent === "number"
        && primary.usedPercent > 0
        && typeof primary.resetsAt === "number"
        && primary.resetsAt * 1000 > now
    );
}

function codexEnv() {
    return { ...process.env, CODEX_HOME };
}

export function readCodexRateLimits() {
    return new Promise((resolve, reject) => {
        const child = spawn("codex", ["app-server", "--stdio"], {
            cwd: WORKSPACE_DIR,
            env: codexEnv(),
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill();
            if (error) reject(error);
            else resolve(value);
        };
        const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
        const timer = setTimeout(
            () => finish(new Error(`Codex rate-limit query timed out: ${stderr.slice(-500)}`)),
            RATE_LIMIT_TIMEOUT_MS,
        );

        child.stderr.on("data", (chunk) => {
            stderr = `${stderr}${chunk}`.slice(-2000);
        });
        child.on("error", (error) => finish(error));
        child.on("exit", (code) => {
            if (!settled) finish(new Error(`Codex app-server exited ${code}: ${stderr.slice(-500)}`));
        });
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            for (;;) {
                const newline = stdout.indexOf("\n");
                if (newline < 0) break;
                const line = stdout.slice(0, newline);
                stdout = stdout.slice(newline + 1);
                let message;
                try {
                    message = JSON.parse(line);
                } catch {
                    continue;
                }
                if (message.id === 0 && message.result) {
                    send({ method: "initialized", params: {} });
                    send({ method: "account/rateLimits/read", id: 1 });
                } else if (message.id === 1) {
                    if (message.error) finish(new Error(message.error.message || "Codex rate-limit query failed"));
                    else finish(null, normalizeRateLimits(message.result));
                }
            }
        });

        send({
            method: "initialize",
            id: 0,
            params: { clientInfo: { name: "ai_quota_openai", title: "AI Quota OpenAI", version: "1.0.0" } },
        });
    });
}

export function runCodex(message) {
    return new Promise((resolve, reject) => {
        const args = [
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox", "read-only",
            "--skip-git-repo-check",
            "--color", "never",
            message,
        ];
        const child = spawn("codex", args, {
            cwd: WORKSPACE_DIR,
            env: codexEnv(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
        child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-4000); });
        child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("exit", (code, signal) => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`Codex exited ${code ?? signal}: ${stderr.slice(-1000)}`));
        });
    });
}

async function loadLedger() {
    try {
        const parsed = JSON.parse(await readFile(LEDGER_PATH, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
        if (error?.code === "ENOENT") return {};
        throw error;
    }
}

async function saveLedger(ledger) {
    await mkdir(DATA_DIR, { recursive: true });
    const entries = Object.entries(ledger)
        .sort(([, a], [, b]) => (b?.completedAt ?? "").localeCompare(a?.completedAt ?? ""))
        .slice(0, MAX_LEDGER_ENTRIES);
    const temp = `${LEDGER_PATH}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
    await rename(temp, LEDGER_PATH);
}

let queue = Promise.resolve();

export function enqueue(task) {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
}

export async function performWarmup({ message, idempotencyKey, force = false }, deps = {}) {
    const readLimits = deps.readLimits ?? readCodexRateLimits;
    const execute = deps.execute ?? runCodex;
    const now = deps.now ?? Date.now;
    const load = deps.load ?? loadLedger;
    const save = deps.save ?? saveLedger;
    const ledger = await load();
    if (ledger[idempotencyKey]) return { ...ledger[idempotencyKey], idempotentReplay: true };

    const before = await readLimits();
    if (!force && hasOpenWindow(before, now())) {
        return {
            success: true,
            action: "skipped",
            reason: "window-still-open",
            nextResetAt: nextResetAt(before),
            rateLimits: before,
        };
    }

    const reply = await execute(message);
    const after = await readLimits();
    const result = {
        success: true,
        action: "pinged",
        reply,
        nextResetAt: nextResetAt(after),
        rateLimits: after,
        completedAt: new Date(now()).toISOString(),
    };
    ledger[idempotencyKey] = result;
    await save(ledger);
    return result;
}

async function readJsonBody(request) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 });
    }
}

function respond(response, status, body) {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
}

export function buildHandler(deps = {}) {
    const sharedSecret = deps.sharedSecret ?? process.env.WARMUP_SHARED_SECRET ?? "";
    const warmup = deps.warmup ?? performWarmup;
    return async (request, response) => {
        if (request.method === "GET" && request.url === "/health") {
            return respond(response, 200, {
                ok: true,
                authenticated: existsSync(join(CODEX_HOME, "auth.json")),
            });
        }
        if (request.method !== "POST" || request.url !== "/warmup") {
            return respond(response, 404, { error: "Not found" });
        }
        const authorization = request.headers.authorization ?? "";
        if (!sharedSecret || !secureEqual(authorization, `Bearer ${sharedSecret}`)) {
            return respond(response, 401, { error: "Unauthorized" });
        }

        try {
            const body = await readJsonBody(request);
            const idempotencyKey = request.headers["idempotency-key"];
            if (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 200) {
                return respond(response, 400, { error: "A valid Idempotency-Key header is required" });
            }
            const message = typeof body?.message === "string" ? body.message.trim() : "";
            if (!message || message.length > 1000) {
                return respond(response, 400, { error: "message must contain 1-1000 characters" });
            }
            const result = await enqueue(() => warmup({
                message,
                idempotencyKey,
                force: body?.force === true,
            }));
            console.log(JSON.stringify({ event: "warmup.complete", action: result.action, idempotencyKey }));
            return respond(response, 200, result);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(JSON.stringify({ event: "warmup.failure", error: message }));
            return respond(response, error?.statusCode ?? 502, { success: false, error: message });
        }
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    const server = createServer(buildHandler());
    server.listen(PORT, "0.0.0.0", () => {
        console.log(JSON.stringify({ event: "server.ready", port: PORT }));
    });
}
