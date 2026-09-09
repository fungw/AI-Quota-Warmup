/**
 * Scheduled warm-up ping to the Anthropic API, to open Claude Code's
 * 5-hour rate-limit window at predictable times of day.
 *
 * Why this is more than a cron: a warm-up ping only opens a new window if the
 * previous one has already expired. A ping that lands inside an open window is
 * silently wasted, and a fixed cron has no way to know. Worse, one late ping
 * shifts the window boundary later, which can swallow the *next* scheduled
 * ping too — so a single delay cascades through the rest of the day.
 *
 * So instead of pinging on a fixed schedule, we tick often and gate each ping
 * on the window state:
 *
 *   - The API reports `anthropic-ratelimit-unified-5h-reset` on every response.
 *     That is the authoritative window boundary; we persist it to KV.
 *   - Each tick pings only if (a) we are inside the catch-up horizon after one
 *     of the TARGETS_LOCAL times (in TARGET_TIMEZONE), (b) that target hasn't been served yet, and
 *     (c) the stored reset time has passed.
 *   - Otherwise the tick does nothing and costs no API call.
 *
 * Note there is no way to *check* the window cheaply: reading the reset header
 * requires a request, and a request opens a window if none is open. Hence the
 * stored reset time — we remember rather than poll.
 *
 * A late tick therefore costs minutes, not a whole window, and the schedule
 * re-anchors to the real boundary on every ping rather than accumulating drift.
 *
 * See src/tick.ts for the gating decision, src/schedule.ts for the DST-aware
 * target-slot arithmetic, and src/anthropic.ts for the API call itself.
 */

import type { Env } from "./config";
import { DEFAULT_TARGETS, resolveConfig } from "./config";
import { currentTarget } from "./schedule";
import { readState } from "./state";
import { tick } from "./tick";

export default {
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(
            tick(env, { trigger: "cron", cron: controller.cron, scheduledTime: controller.scheduledTime })
        );
    },

    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
            const now = new Date();
            const configResult = resolveConfig(env);

            // Bug fix: a bad TARGETS_LOCAL used to throw straight out of this
            // handler as an opaque 500. Report the parse error explicitly instead.
            if (!configResult.ok) {
                return Response.json(
                    { ok: false, error: `Invalid configuration: ${configResult.error}` },
                    { status: 500 }
                );
            }
            const { config } = configResult;
            const providerHealth = await Promise.all(
                config.providers.map(async (provider) => {
                    const state = await readState(env, provider);
                    const isOpenAi = provider === "openai";
                    return {
                        provider,
                        model: isOpenAi ? env.GPT_MODEL || "gpt-5.2" : "claude-haiku-4-5-20251001",
                        tokenConfigured: Boolean(isOpenAi ? env.OPENAI_API_KEY : env.CLAUDE_CODE_OAUTH_TOKEN),
                        state: {
                            ...state,
                            nextResetAtIso:
                                state.nextResetAt === null ? null : new Date(state.nextResetAt).toISOString(),
                            minutesUntilReset:
                                state.nextResetAt === null
                                    ? null
                                    : Math.round((state.nextResetAt - now.getTime()) / 60_000),
                        },
                    };
                }),
            );
            const first = providerHealth[0];

            return Response.json({
                ok: true,
                now: now.toISOString(),
                targetsLocal: env.TARGETS_LOCAL || DEFAULT_TARGETS,
                targetTimezone: config.timeZone,
                providers: providerHealth,
                // Compatibility fields for existing single-provider clients.
                provider: config.provider,
                model: first.model,
                catchupHorizonMinutes: config.horizonMinutes,
                currentTargetSlot: currentTarget(now, config.targets, config.timeZone, config.horizonMs)?.toISOString() ?? null,
                tokenConfigured: first.tokenConfigured,
                manualTriggerEnabled: Boolean(env.DEBUG_TRIGGER_SECRET),
                state: first.state,
            });
        }

        if (url.pathname !== "/run") {
            return new Response("Not found. Try /health or POST /run.", { status: 404 });
        }

        if (!env.DEBUG_TRIGGER_SECRET) {
            return Response.json(
                { error: "Manual trigger disabled. Set DEBUG_TRIGGER_SECRET to enable." },
                { status: 403 }
            );
        }
        if (request.headers.get("authorization") !== `Bearer ${env.DEBUG_TRIGGER_SECRET}`) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        // ?force=1 bypasses gating — useful for testing the ping path, but it
        // will burn a request inside an already-open window.
        const report = await tick(env, {
            trigger: "manual",
            cron: null,
            scheduledTime: null,
            force: url.searchParams.get("force") === "1",
        });
        return Response.json(report, { status: report.success ? 200 : 500 });
    },
};
