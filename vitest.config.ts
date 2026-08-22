import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@guionai/web-core": fileURLToPath(new URL("./packages/web-core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    pool: "forks",
  },
});
