FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && update-ca-certificates \
 && test -s /etc/ssl/certs/ca-certificates.crt \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex \
 && mkdir -p /home/node/.codex \
 && chown -R node:node /home/node/.codex
ENV HOME=/home/node CODEX_HOME=/home/node/.codex
WORKDIR /opt/codex-runner
COPY apps/codex-runner/server.mjs ./server.mjs
USER node
EXPOSE 4300
CMD ["node","server.mjs"]
