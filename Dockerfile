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

# Dedicated, locked, non-login identities (UD-1). No home directory, no login shell, no supplementary
# groups. 10001 runs the API; 10002 runs migrations (docker-compose.yml, service "migrate").
# /var/lib/eltnoy/documents is the private institution-document root: a fresh named volume mounted
# there inherits 10001:10001 0700 from the image.
RUN groupadd --system --gid 10001 eltnoy-api \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin eltnoy-api \
 && groupadd --system --gid 10002 eltnoy-migrate \
 && useradd --system --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin eltnoy-migrate \
 && usermod --lock eltnoy-api && usermod --lock eltnoy-migrate \
 && install -d -o 10001 -g 10001 -m 0700 /var/lib/eltnoy/documents

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application files stay owned by root: neither runtime identity can modify them.
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/utils/examSchedule.ts ./src/utils/examSchedule.ts
COPY --from=build /app/src/utils/institutionDocuments.ts ./src/utils/institutionDocuments.ts

USER 10001:10001
EXPOSE 4000

# Node is PID 1 (no npm): SIGTERM reaches the API's graceful shutdown and npm writes no log files.
CMD ["node", "--import", "tsx", "server/index.ts"]
