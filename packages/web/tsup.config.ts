import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", "generate-openapi": "src/generate-openapi.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  clean: true,
  dts: true,
  noExternal: [
    "@guionai/web-core",
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/core",
    "commander",
    "defuddle",
    "linkedom",
    "markdown-it",
    "@hono/node-server",
    "@hono/zod-openapi",
    "hono",
    "zod",
    "yaml",
  ],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
