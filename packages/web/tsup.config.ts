import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const packageManifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: unknown };
if (
  typeof packageManifest.version !== "string" ||
  packageManifest.version.length === 0
)
  throw new Error("package version is required to build the Web CLI");

export default defineConfig({
  entry: { cli: "src/cli.ts", "generate-openapi": "src/generate-openapi.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  clean: true,
  dts: true,
  define: {
    __WEB_PACKAGE_VERSION__: JSON.stringify(packageManifest.version),
  },
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
