FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap ca-certificates git \
 && update-ca-certificates \
 && test -s /etc/ssl/certs/ca-certificates.crt \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@0.167.1 \
 && mkdir -p /home/node/.codex /var/lib/ado-runner \
 && chown -R node:node /home/node/.codex /var/lib/ado-runner
ENV HOME=/home/node CODEX_HOME=/home/node/.codex
WORKDIR /opt/codex-runner
COPY apps/codex-runner/server.mjs ./server.mjs
COPY apps/codex-runner/agent-mcp.mjs apps/codex-runner/job-journal.mjs apps/codex-runner/execution-policy.mjs ./
USER node
EXPOSE 4300
CMD ["node","server.mjs"]
