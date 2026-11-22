# syntax=docker/dockerfile:1
# pasukkun 이미지. 하나의 Dockerfile 에서 두 대상을 만든다.
#   server : API 와 Worker 가 함께 쓰는 이미지 (시작 명령만 다르다)
#   proxy  : 프론트 정적 파일을 제공하고 /api 를 내부의 api 로 넘기는 Caddy

# - 빌드 -
FROM node:24.22.3-bookworm-slim AS build
# better-sqlite3 의 사전 빌드 바이너리를 받지 못할 때 직접 빌드할 수 있도록 도구를 둔다.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/api-types/package.json packages/api-types/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @pasukkun/server build
RUN pnpm --filter @pasukkun/web build

# - API / Worker -
FROM node:24.22.3-bookworm-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/pasukkun.db
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server ./apps/server
USER node
WORKDIR /app/apps/server
VOLUME ["/data"]
EXPOSE 3000
# 기본은 API. Worker 는 compose 에서 명령을 바꿔 실행한다.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main.js"]

# - 프록시 + 프론트 정적 파일 -
FROM caddy:2.11.9-alpine AS proxy
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
