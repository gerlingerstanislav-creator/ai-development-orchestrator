FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /opt/qa-browser
RUN npm install --no-audit --no-fund --no-save playwright@1.56.1 \
 && mkdir -p /var/lib/ado-qa-workspaces /home/ado-qa \
 && chown -R 1000:1000 /opt/qa-browser /var/lib/ado-qa-workspaces /home/ado-qa
COPY apps/qa-browser/server.mjs apps/qa-browser/browser-smoke.mjs ./
USER 1000:1000
ENV HOME=/home/ado-qa QA_WORKSPACES_DIR=/var/lib/ado-qa-workspaces
EXPOSE 4301
CMD ["node","server.mjs"]
