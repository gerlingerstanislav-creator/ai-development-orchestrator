FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates git python3 python3-pip python3-venv python3-pytest \
 && update-ca-certificates \
 && test -s /etc/ssl/certs/ca-certificates.crt \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@0.167.1 \
 && command -v python3 && command -v pytest \
 && codex_native="$(find "$(npm root -g)/@openai" -type f -path '*/vendor/*/bin/codex')" \
 && test -x "$codex_native" \
 && ln -s "$codex_native" /usr/local/bin/codex-linux-sandbox \
 && codex-linux-sandbox --help >/dev/null \
 && mkdir -p /home/node/.codex /var/lib/ado-runner \
 && chown -R node:node /home/node/.codex /var/lib/ado-runner
ENV HOME=/home/node CODEX_HOME=/home/node/.codex
WORKDIR /opt/codex-runner
COPY apps/codex-runner/server.mjs ./server.mjs
COPY apps/codex-runner/agent-mcp.mjs apps/codex-runner/job-journal.mjs apps/codex-runner/execution-policy.mjs apps/codex-runner/qa-preflight.mjs ./
USER node
EXPOSE 4300
CMD ["node","server.mjs"]
