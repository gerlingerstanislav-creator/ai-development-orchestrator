FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates git python3 python3-pip python3-venv python3-pytest postgresql-15 \
 && update-ca-certificates \
 && test -s /etc/ssl/certs/ca-certificates.crt \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@0.167.1 \
 && command -v python3 && command -v pytest \
 && codex_native="$(find "$(npm root -g)/@openai" -type f -path '*/vendor/*/bin/codex')" \
 && test -x "$codex_native" \
 && ln -s "$codex_native" /usr/local/bin/codex-linux-sandbox \
 && codex-linux-sandbox --help >/dev/null \
 && mkdir -p /home/node/.codex /var/lib/ado-runner /var/lib/ado-qa-workspaces \
 && chown -R node:node /home/node/.codex /var/lib/ado-runner /var/lib/ado-qa-workspaces
ENV HOME=/home/node CODEX_HOME=/home/node/.codex
WORKDIR /opt/codex-runner
COPY apps/codex-runner/server.mjs ./server.mjs
COPY apps/codex-runner/command-executor.mjs ./command-executor.mjs
COPY apps/api/src/prompt-assembler.mjs /opt/api/src/prompt-assembler.mjs
COPY apps/codex-runner/qa-prompt.mjs apps/codex-runner/developer-prompt.mjs apps/codex-runner/qa-tools.md ./
COPY apps/codex-runner/browser-gateway.mjs apps/codex-runner/browser-client.mjs apps/codex-runner/qa-exec.mjs ./
COPY apps/codex-runner/agent-context.mjs apps/codex-runner/agent-mcp.mjs apps/codex-runner/job-journal.mjs apps/codex-runner/job-scheduler.mjs apps/codex-runner/development-outcome.mjs apps/codex-runner/execution-policy.mjs apps/codex-runner/qa-preflight.mjs apps/codex-runner/qa-run-evidence.mjs apps/codex-runner/qa-completion.mjs apps/codex-runner/rate-limits.mjs apps/codex-runner/chat-images.mjs ./
# Run exactly the import+HTTP smoke check used in CI against the image
# rather than just checking server.mjs syntax on the GitHub host.
COPY apps/codex-runner/startup-smoke.mjs ./startup-smoke.mjs
USER node
EXPOSE 4300
CMD ["node","server.mjs"]
