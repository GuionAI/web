import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CDN_ALLOWLIST = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "ajax.googleapis.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "esm.sh",
];
const REPORT_URL = "https://github.com/guionai/web/issues/new";
let artifactRoot = "";
let artifactTemp = "";
let artifactContents = "";

beforeAll(() => {
  execFileSync("pnpm", ["run", "build"], { cwd: packageRoot, stdio: "ignore" });
  artifactTemp = mkdtempSync(
    join(tmpdir(), "guionai-dsh-web-packed-contract-"),
  );
  execFileSync("pnpm", ["pack", "--pack-destination", artifactTemp], {
    cwd: packageRoot,
    stdio: "ignore",
  });
  const tarballs = readdirSync(artifactTemp).filter((file) =>
    file.endsWith(".tgz"),
  );
  if (tarballs.length !== 1)
    throw new Error("expected one packed DSH Web artifact");
  const tarContents = execFileSync(
    "tar",
    ["-tzf", join(artifactTemp, tarballs[0]!)],
    { encoding: "utf8" },
  );
  artifactContents = tarContents;
  if (
    /agent-browser|chrom(e|ium)|playwright|puppeteer|node_modules\/@.*\/(linux|darwin|win32)/i.test(
      tarContents,
    )
  )
    throw new Error("DSH tarball contains browser or platform artifacts");
  const installed = join(artifactTemp, "installed");
  mkdirSync(installed);
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({ name: "dsh-web-packed-contract", private: true }) + "\n",
  );
  execFileSync(
    "pnpm",
    ["add", "--ignore-scripts", `file:${join(artifactTemp, tarballs[0]!)}`],
    {
      cwd: installed,
      env: {
        ...process.env,
        npm_config_store_dir: join(artifactTemp, "store"),
      },
      stdio: "ignore",
    },
  );
  artifactRoot = join(installed, "node_modules", "@guionai", "dsh-web");
  writeHostFakes();
}, 30_000);

function writeFakeAgentBrowser(): { bin: string; log: string } {
  const bin = join(artifactTemp, "fake-browser-bin");
  const log = join(artifactTemp, "agent-browser.jsonl");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "agent-browser"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const command = args.includes("close") ? "close" : args.includes("eval") ? "eval" : "open";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (command === "open" && args.some((value) => value.includes("/blocked"))) {
  console.log(JSON.stringify({ success: false, error: { message: "domain not allowed", hostname: "missing.cdn.test" } }));
  process.exit(1);
}
if (command === "eval")
  console.log(JSON.stringify({ success: true, data: { result: JSON.stringify({ html: "<html><body><article><p>Packed DSH rendered fixture.</p></article></body></html>", url: "https://93.184.216.34/rendered" }) } }));
else console.log(JSON.stringify({ success: true, data: {} }));
`,
  );
  chmodSync(join(bin, "agent-browser"), 0o700);
  return { bin, log };
}

function writeHostFakes(): void {
  const dependencies = {
    "dsh-settings": "export {};\n",
    schemastery:
      "const string = () => { const schema = { pattern: () => schema, default: () => schema }; return schema; }; const z = { object: () => ({}), string, union: () => ({ default: () => ({}) }) }; export default z;\n",
    "dsh-credentials": "export function credentialRef(ref) { return ref; }\n",
    "dsh-tools":
      "export function defineTool(definition) { return definition; }\n",
  };
  for (const [name, source] of Object.entries(dependencies)) {
    const directory = join(artifactRoot, "node_modules", "@deepseek-ai", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.js" }) + "\n",
    );
    writeFileSync(join(directory, "index.js"), source);
  }
}

afterAll(() => {
  if (artifactTemp !== "")
    rmSync(artifactTemp, { recursive: true, force: true });
});
function manifest(): any {
  return JSON.parse(readFileSync(join(artifactRoot, "package.json"), "utf8"));
}

describe("DSH 0.1.2-rc.1 packed package contract", () => {
  it("contains valid host ESM, browser client, declarations, patch, and peer-only metadata", async () => {
    const packed = manifest();
    const host = await import(
      `${pathToFileURL(join(artifactRoot, "dist", "index.js")).href}?host=1`
    );
    expect(packed.name).toBe("@guionai/dsh-web");
    expect(packed.main).toBe("dist/index.js");
    expect(packed.types).toBe("dist/index.d.ts");
    expect(packed.dsh).toEqual({
      bundle: { patch: "./cordis.patch.yml" },
      client: {
        platform: "web",
        inject: [
          "@deepseek-ai/dsh-api-remotes",
          "@deepseek-ai/dsh-client-connection",
          "@deepseek-ai/dsh-client-locale",
          "@deepseek-ai/dsh-client-ui-renderer",
          "@deepseek-ai/dsh-client-ui-primitives",
          "@deepseek-ai/dsh-client-ui-tool",
          "@deepseek-ai/dsh-client-ui-settings",
          "@deepseek-ai/dsh-client-ui-settings-plugins",
        ],
      },
    });
    expect(packed.exports["./client"]).toEqual({
      types: "./dist/client.d.cts",
      default: "./dist/client.js",
    });
    expect(readdirSync(join(artifactRoot, "dist"))).toEqual(
      expect.arrayContaining([
        "index.js",
        "index.d.ts",
        "client.js",
        "client.d.cts",
      ]),
    );
    expect(packed.dependencies).toBeUndefined();
    expect(packed.optionalDependencies).toBeUndefined();
    expect(packed.peerDependencies["@deepseek-ai/cordis"]).toBe("4.0.2");
    expect(packed.peerDependencies["@deepseek-ai/dsh-client-runtime"]).toBe(
      undefined,
    );
    expect(packed.peerDependencies["@deepseek-ai/dsh-web"]).toBeUndefined();
    for (const [name, version] of Object.entries(packed.peerDependencies)) {
      if (
        name.startsWith("@deepseek-ai/") &&
        name !== "@deepseek-ai/cordis" &&
        name !== "@deepseek-ai/schemastery"
      )
        expect(version, `${name} peer`).toBe("0.1.2-rc.1");
    }
    expect(artifactContents).not.toContain("dsh-client-runtime");
    expect(artifactContents).not.toContain("0.1.1-rc.2");
    const packedHostSource = readFileSync(
      join(artifactRoot, "dist", "index.js"),
      "utf8",
    );
    const packedClientSource = readFileSync(
      join(artifactRoot, "dist", "client.js"),
      "utf8",
    );
    expect(packedHostSource).toContain("kepos-bridge");
    expect(packedHostSource).toContain("web_weather");
    expect(packedHostSource).toContain("keposBridgeEndpoint");
    expect(packedClientSource).toContain("Kepos Bridge endpoint");
    expect(
      Object.keys(packed.peerDependencies).some((name) =>
        /agent-browser|chrom(e|ium)|playwright|puppeteer/i.test(name),
      ),
    ).toBe(false);
    expect(
      packed.scripts?.preinstall ??
        packed.scripts?.install ??
        packed.scripts?.postinstall,
    ).toBeUndefined();
    expect(JSON.stringify(packed)).not.toContain("workspace:");
    expect(
      Object.keys(packed.peerDependencies).filter(
        (name) => name === "react" || name.startsWith("@deepseek-ai/"),
      ).length,
    ).toBeGreaterThan(10);
    expect(host.name).toBe("guionai-dsh-web");
    expect(host.inject).toEqual(["credentials", "settings", "tools"]);
    const tools: any[] = [];
    const browser = writeFakeAgentBrowser();
    const originalFetch = globalThis.fetch;
    const originalPath = process.env.PATH;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url) === "https://93.184.216.34/direct")
        return new Response(
          "<html><body><article><p>Packed DSH browserless fixture.</p></article></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      if (String(url) === "https://93.184.216.34/links")
        return new Response(
          '<html><body><nav><a href="/destination">Packed link</a></nav></body></html>',
          { headers: { "content-type": "text/html" } },
        );
      expect(String(url)).toBe("https://api.exa.ai/search");
      expect(
        (init.headers as Headers).get?.("x-api-key") ??
          (init.headers as any)["x-api-key"],
      ).toBe("fixture-key");
      return Response.json({
        results: [
          {
            title: "Packed",
            url: "https://example.test",
            highlights: ["fixture"],
          },
        ],
      });
    };
    try {
      host.apply({
        settings: {
          register: () => ({
            get: () => ({
              provider: "exa",
              keposBridgeEndpoint:
                "http://codex-bridge.localhost:17480/codex/web-search",
            }),
            watch: () => () => undefined,
          }),
        },
        credentials: {
          resolve: async () => ({ value: "fixture-key", source: "test" }),
        },
        tools: {
          register: (definition: unknown) => {
            tools.push(definition);
            return () => undefined;
          },
        },
        effect: (execute: () => () => void) => execute(),
      });
      const searchTool = tools.find(
        (definition) => definition.name === "web_search",
      );
      if (!searchTool)
        throw new Error("packed DSH artifact did not register web_search");
      await expect(
        searchTool.execute(
          { queries: ["packed fixture"] },
          { signal: new AbortController().signal },
        ),
      ).resolves.toMatchObject({
        provider: "Exa",
        results: [
          {
            link: "https://example.test",
            title: "Packed",
            snippet: "fixture",
            position: 1,
          },
        ],
      });
      const fetchTool = tools.find(
        (definition) => definition.name === "web_fetch",
      );
      if (!fetchTool)
        throw new Error("packed DSH artifact did not register web_fetch");
      const linksTool = tools.find(
        (definition) => definition.name === "web_links",
      );
      if (!linksTool)
        throw new Error("packed DSH artifact did not register web_links");
      process.env.PATH = `${browser.bin}:${originalPath ?? ""}`;
      const direct = await fetchTool.execute(
        { url: "https://93.184.216.34/direct", mode: "full" },
        { signal: new AbortController().signal },
      );
      expect(direct.content).toBe("Packed DSH browserless fixture.\n");
      expect(() => readFileSync(browser.log, "utf8")).toThrow();
      const links = await linksTool.execute(
        { url: "https://93.184.216.34/links" },
        { signal: new AbortController().signal },
      );
      expect(links.links).toEqual([
        {
          text: "Packed link",
          url: "https://93.184.216.34/destination",
        },
      ]);
      const rendered = await fetchTool.execute(
        {
          url: "https://93.184.216.34/rendered",
          render: "browser",
          waitMs: 0,
          mode: "full",
        },
        { signal: new AbortController().signal },
      );
      expect(rendered.content).toBe("Packed DSH rendered fixture.\n");
      const browserCommands = readFileSync(browser.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const open = browserCommands[0]!;
      expect(open[open.indexOf("--allowed-domains") + 1]).toBe(
        ["93.184.216.34", "*.93.184.216.34", ...CDN_ALLOWLIST].join(","),
      );
      expect(browserCommands).toHaveLength(3);
      await expect(
        fetchTool.execute(
          {
            url: "https://93.184.216.34/blocked",
            render: "browser",
            waitMs: 0,
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({
        code: "render_domain_not_allowed",
        details: { retryable: false, reportUrl: REPORT_URL },
      });
    } finally {
      process.env.PATH = originalPath;
      globalThis.fetch = originalFetch;
    }

    const patch = parse(
      readFileSync(join(artifactRoot, "cordis.patch.yml"), "utf8"),
    ) as any[];
    for (const id of [
      "web",
      "web-search-deepseek",
      "web-fetch-http",
      "tool-web",
    ])
      expect(patch.find((entry) => entry.id === id)).toEqual({
        id,
        disabled: true,
      });
    expect(patch.find((entry) => entry.id === "agent-presets")).toEqual({
      id: "agent-presets",
      name: "@deepseek-ai/dsh-agent-presets",
      config: {
        includeShippedRoot: false,
        includeUserRoot: true,
        default: "standard",
      },
    });
    expect(
      patch.find((entry) => Array.isArray(entry.insert))?.insert,
    ).toContainEqual({
      id: "guionai-dsh-web",
      name: "@guionai/dsh-web",
      inject: ["credentials", "settings", "tools"],
    });
  }, 30_000);

  it("loads the packed browser entry through the supported lazy module contract", async () => {
    const previousWindow = (globalThis as any).window;
    const registrations: any[] = [];
    (globalThis as any).window = {
      __ModuleLoader__: {
        load: (registration: unknown) => registrations.push(registration),
      },
    };
    try {
      await import(
        `${pathToFileURL(join(artifactRoot, "dist", "client.js")).href}?client=1`
      );
      expect(registrations).toHaveLength(1);
      expect(registrations[0].id).toBe("@guionai/dsh-web");
      const loaded = registrations[0].factory((specifier: string) => {
        if (specifier === "@deepseek-ai/dsh-client-ui-primitives") {
          return { IconChevronDownOutline14: () => ({}) };
        }
        expect(specifier).toBe("react");
        return {
          createElement: () => ({}),
          useEffect: () => undefined,
          useId: () => "fixture",
          useState: <T>(value: T) => [value, () => undefined] as const,
        };
      });
      expect(loaded.inject).toEqual([
        "remote",
        "remote.credentials",
        "settingsScope",
        "slots",
      ]);
      expect(typeof loaded.apply).toBe("function");
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });
});
