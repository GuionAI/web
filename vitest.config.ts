import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import { compileCssModule } from "./packages/dsh-web/scripts/css-modules.js";

const webPackageManifest = JSON.parse(
  readFileSync(new URL("./packages/web/package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __WEB_PACKAGE_VERSION__: JSON.stringify(webPackageManifest.version),
  },
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
