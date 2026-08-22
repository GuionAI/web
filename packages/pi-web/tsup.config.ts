import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  clean: true,
  dts: true,
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"],
  noExternal: ["@guionai/web-core", "defuddle", "linkedom", "markdown-it"],
});
