FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /opt/qa-browser
RUN npm install --no-audit --no-fund --no-save playwright@1.56.1 \
 && mkdir -p /var/lib/ado-qa-workspaces \
 && chown -R pwuser:pwuser /opt/qa-browser /var/lib/ado-qa-workspaces
COPY apps/qa-browser/server.mjs ./server.mjs
USER pwuser
ENV HOME=/home/pwuser QA_WORKSPACES_DIR=/var/lib/ado-qa-workspaces
EXPOSE 4301
CMD ["node","server.mjs"]
