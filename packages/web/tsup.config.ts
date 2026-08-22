import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  clean: true,
  dts: true,
  noExternal: ["@guionai/web-core"],
});
