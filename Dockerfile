FROM node:24-bookworm-slim AS runtime

# Build-only: package scripts must not prompt. ARG keeps it out of the runtime environment.
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv bubblewrap ca-certificates git libreoffice-writer libreoffice-calc libreoffice-impress ffmpeg \
       tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa tesseract-ocr-cat tesseract-ocr-fra tesseract-ocr-por tesseract-ocr-deu tesseract-ocr-ita \
       pandoc graphviz libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime and telemetry dependencies are pinned together in package-lock.json.
# The image ships the npm bundled with its pinned Node; no in-build npm self-update.
RUN npm ci --omit=dev --include=optional --no-fund --no-update-notifier && rm -rf "$(npm config get cache)"
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY docker/ ./docker/
RUN node scripts/setup-files.mjs \
    && runtime-tools/bin/python -c "import weasyprint" \
    && pandoc --version >/dev/null && dot -V \
    && node scripts/container-cli.mjs codex --version \
    && node scripts/container-cli.mjs claude --version \
    && install -m 755 docker/entrypoint.sh /usr/local/bin/bridge \
    && mkdir -p /auth/codex /auth/claude /data \
    && chown -R node:node /auth /data \
    && chmod 700 /auth /auth/codex /auth/claude /data

# Credential locations default to CODEX_HOME and CLAUDE_CONFIG_DIR; no *_AUTH_DIR duplicates.
ENV HOME=/auth CODEX_HOME=/auth/codex CLAUDE_CONFIG_DIR=/auth/claude \
    BRIDGE_DATA_DIR=/data BRIDGE_HOST=0.0.0.0 BRIDGE_PORT=4000
USER node
EXPOSE 4000
ENTRYPOINT ["bridge"]
CMD ["serve"]

# No production credentials or volumes are present in this build stage.
FROM runtime AS ci
COPY --chown=node:node .env.example /app/.env.example
COPY --chown=node:node test/ /app/test/
COPY --chown=node:node ci/test.sh /app/ci/test.sh
RUN sh ci/test.sh

FROM ci AS production
