FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspace @orchestrator/api
COPY apps/api apps/api
RUN npm run build -w apps/api
USER node
CMD ["npm","run","start","-w","apps/api"]
