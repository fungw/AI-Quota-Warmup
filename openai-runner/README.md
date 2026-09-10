# OpenAI Codex runner

Fly.io service used by the Cloudflare scheduler to open ChatGPT/Codex quota
windows. It runs the official Codex CLI with ChatGPT-managed authentication;
it does not use an OpenAI Platform API key.

The HTTP service scales to zero, persists Codex's renewable `auth.json` on the
encrypted `codex_data` Fly volume, and accepts only authenticated `POST
/warmup` requests. Idempotency state lives on the same volume.

Authentication material must never be committed to this public repository or
stored in the container image. Provision it once after deployment with the
Codex device-code login while connected through `fly ssh console`.

## Deployment

```bash
fly apps create your-fly-app
fly volumes create codex_data --app your-fly-app --region lhr --size 1
fly secrets set --app your-fly-app WARMUP_SHARED_SECRET=<random-secret>
fly deploy --app your-fly-app --ha=false
fly ssh console --app your-fly-app --command 'codex login --device-auth'
```

Use the same random secret for the Cloudflare Worker's `GPT_WARMUP_SECRET`.
The Worker URL is `https://your-fly-app.fly.dev/warmup`.

The runner queries `account/rateLimits/read` before making a model request. If
the current Codex window is still open, it returns the real reset timestamp
without spending tokens. Successful target slots are recorded on the volume,
so a retry after a lost HTTP response cannot issue a duplicate model request.
