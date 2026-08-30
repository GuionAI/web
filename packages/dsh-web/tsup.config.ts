import { defineConfig } from "tsup";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { compileCssModule } from "./scripts/css-modules.js";

const dshExternals = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-tool",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-web",
  "@deepseek-ai/schemastery",
];

function cssModulesPlugin(): EsbuildPlugin {
  return {
    name: "guion-dsh-css-modules",
    setup(build) {
      build.onLoad({ filter: /\.module\.dshcss$/ }, async (args) => {
        const { css, classes } = await compileCssModule(args.path);
        const styleId = "@guionai/dsh-web/settings.module.css";
        return {
          loader: "js",
          contents: [
            `const css=${JSON.stringify(css)};`,
            `const styleId=${JSON.stringify(styleId)};`,
            "if(typeof document!=='undefined'&&!document.querySelector(`style[data-plugin-css=\"${styleId}\"]`)){const tag=document.createElement('style');tag.dataset.pluginCss=styleId;tag.textContent=css;document.head.appendChild(tag)}",
            `export default ${JSON.stringify(classes)};`,
          ].join("\n"),
        };
      });
    },
  };
}

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    bundle: true,
    dts: true,
    sourcemap: false,
    clean: true,
    external: [...dshExternals, "react"],
    noExternal: ["@guionai/web-core", "defuddle", "linkedom", "markdown-it"],
  },
  {
    entry: { client: "src/client.ts" },
    format: ["cjs"],
    platform: "browser",
    loader: { ".css": "text" },
    target: "es2022",
    bundle: true,
    dts: true,
    sourcemap: false,
    clean: false,
    esbuildPlugins: [cssModulesPlugin()],
    external: ["react", ...dshExternals],
    outExtension: () => ({ js: ".js" }),
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "@guionai/dsh-web", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: "return module.exports; } });" },
  },
]);
