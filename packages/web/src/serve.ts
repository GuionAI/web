import { serve, type ServerType } from "@hono/node-server";

import { createHttpApp, type HttpServiceDependencies } from "./http.js";

export const DEFAULT_HTTP_HOST = "0.0.0.0";
export const DEFAULT_HTTP_PORT = 8787;

export type HttpServerOptions = {
  hostname?: string;
  port?: number;
  onListening?: (address: { hostname: string; port: number }) => void;
};

/** Starts the Hono HTTP service on a Node HTTP server. */
export function startHttpServer(
  dependencies: HttpServiceDependencies = {},
  options: HttpServerOptions = {},
): ServerType {
  const app = createHttpApp(dependencies);
  const hostname = options.hostname ?? DEFAULT_HTTP_HOST;
  const port = options.port ?? DEFAULT_HTTP_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("HTTP port must be an integer from 1 through 65535");
  return serve({ fetch: app.fetch, hostname, port }, (address) =>
    options.onListening?.({
      hostname:
        typeof address.address === "string" ? address.address : hostname,
      port: address.port,
    }),
  );
}

export function parseHttpPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("HTTP port must be an integer from 1 through 65535");
  return port;
}
