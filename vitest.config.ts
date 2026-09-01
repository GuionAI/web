import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import { compileCssModule } from "./packages/dsh-web/scripts/css-modules.js";

export default defineConfig({
  plugins: [
    {
      name: "guion-dsh-css-modules-test",
      enforce: "pre",
      async load(id) {
        if (!id.endsWith(".module.dshcss")) return undefined;
        const { classes } = await compileCssModule(id);
        return `export default ${JSON.stringify(classes)};`;
      },
    },
  ],
  resolve: {
    alias: {
      "@guionai/web-core/kepos-bridge": fileURLToPath(
        new URL("./packages/web-core/src/kepos-bridge.ts", import.meta.url),
      ),
      "@guionai/web-core": fileURLToPath(
        new URL("./packages/web-core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    pool: "forks",
    server: { deps: { inline: ["@deepseek-ai/dsh-client-ui-primitives"] } },
  },
});
