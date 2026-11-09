FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspace @orchestrator/api
COPY apps/api apps/api
RUN npm run build -w apps/api
USER node
CMD ["npm","run","start","-w","apps/api"]
