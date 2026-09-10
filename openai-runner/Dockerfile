FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.154.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

WORKDIR /app
COPY package.json server.mjs ./
RUN mkdir -p /app/workspace /data/codex

ENV NODE_ENV=production \
    PORT=8080 \
    CODEX_HOME=/data/codex \
    WARMUP_DATA_DIR=/data

EXPOSE 8080
CMD ["node", "server.mjs"]
