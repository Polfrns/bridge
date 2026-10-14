FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv bubblewrap ca-certificates git libreoffice-writer libreoffice-calc libreoffice-impress ffmpeg tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Keep the existing application lockfile intact and install pinned, isolated telemetry
# dependencies. The instrumentation is fail-open; no keys are baked into the image.
RUN npm ci --omit=dev --include=optional \
    && npm install --no-save --package-lock=false --omit=dev --include=optional --no-audit --no-fund \
       @langfuse/tracing@5.13.1 @langfuse/otel@5.13.1 @opentelemetry/sdk-node@0.223.0 \
    && npm cache clean --force
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY docker/ ./docker/
RUN node scripts/setup-files.mjs \
    && node scripts/container-cli.mjs codex --version \
    && node scripts/container-cli.mjs claude --version \
    && install -m 755 docker/entrypoint.sh /usr/local/bin/bridge \
    && mkdir -p /auth/codex /auth/claude /data \
    && chown -R node:node /auth /data \
    && chmod 700 /auth /auth/codex /auth/claude /data

ENV HOME=/auth CODEX_HOME=/auth/codex CLAUDE_CONFIG_DIR=/auth/claude \
    CODEX_AUTH_DIR=/auth/codex CLAUDE_AUTH_DIR=/auth/claude \
    BRIDGE_DATA_DIR=/data BRIDGE_HOST=0.0.0.0 BRIDGE_PORT=4000
USER node
EXPOSE 4000
ENTRYPOINT ["bridge"]
CMD ["serve"]
