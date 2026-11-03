FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=4000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src/utils/examSchedule.ts ./src/utils/examSchedule.ts
COPY --from=build --chown=node:node /app/src/utils/institutionDocuments.ts ./src/utils/institutionDocuments.ts

USER node
EXPOSE 4000

CMD ["npm", "start"]
