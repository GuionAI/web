# Guion Web's supported HTTP-service image. The build stage bundles the web
# executable; browser rendering is delegated to the configured in-cluster
# Browser Rendering Gateway rather than installed in this image.
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

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# `BROWSER_GATEWAY_URL` is optional at startup; browser requests fail
# explicitly until the operator points the service at the internal gateway.

COPY --from=build /workspace/packages/web/dist ./dist

EXPOSE 8787
ENTRYPOINT ["node", "/app/dist/cli.js", "serve"]
