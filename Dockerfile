# Guion Web's supported HTTP-service image. The build stage bundles the web
# executable; the runtime stage adds the optional rendered-fetch capability.
FROM node:24-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/web-core/package.json packages/web-core/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/pi-web/package.json packages/pi-web/package.json
COPY packages/dsh-web/package.json packages/dsh-web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @guionai/web run build

FROM node:24-bookworm

ENV NODE_ENV=production
WORKDIR /app

# Rendering is deliberately explicit at the HTTP contract. The executable and
# browser runtime are image capabilities, while credentials remain env-only.
ARG AGENT_BROWSER_VERSION=0.36.0
RUN npm install --global agent-browser@${AGENT_BROWSER_VERSION} \
  && agent-browser install

COPY --from=build /workspace/packages/web/dist ./dist

EXPOSE 8787
ENTRYPOINT ["node", "/app/dist/cli.js", "serve"]
