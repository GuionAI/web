import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "guionai-pi-web-pack-smoke-"));
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
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) throw new Error("pnpm entrypoint is unavailable");

async function pnpm(args, cwd) {
  return execFileAsync(process.execPath, [pnpmEntrypoint, ...args], {
    cwd,
    env: {
      ...process.env,
      npm_config_store_dir: join(root, "store"),
      npm_config_ignore_scripts: "true",
    },
  });
}

try {
  const packDirectory = join(root, "pack");
  await pnpm(["pack", "--pack-destination", packDirectory], packageRoot);
  const tarballs = (await readdir(packDirectory)).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (tarballs.length !== 1)
    throw new Error(`expected one tarball, got ${tarballs.join(", ")}`);
  const tarball = join(packDirectory, tarballs[0]);
  const { stdout: tarContents } = await execFileAsync("tar", ["-tzf", tarball]);
  if (
    /agent-browser|chrom(e|ium)|playwright|puppeteer|node_modules\/@.*\/(linux|darwin|win32)/i.test(
      tarContents,
    )
  )
    throw new Error("Pi tarball contains browser or platform artifacts");

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "pi-web-pack-smoke", private: true }),
  );
  await pnpm(
    [
      "add",
      "--ignore-scripts",
      `file:${tarball}`,
      "@earendil-works/pi-ai@0.84.1",
      "@earendil-works/pi-coding-agent@0.84.1",
      "typebox@1.3.7",
    ],
    root,
  );

  const packageDirectory = join(root, "node_modules", "@guionai", "pi-web");
  const manifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  if (JSON.stringify(manifest).includes("workspace:"))
    throw new Error("packed manifest contains workspace protocol");
  if (
    Object.keys(manifest.peerDependencies ?? {})
      .sort()
      .join(",") !==
    "@earendil-works/pi-ai,@earendil-works/pi-coding-agent,typebox"
  ) {
    throw new Error("Pi, Pi AI, and TypeBox must be peer dependencies");
  }
  if (
    manifest.bin ||
    manifest.dependencies ||
    manifest.optionalDependencies ||
    Object.keys(manifest.peerDependencies ?? {}).some((name) =>
      /agent-browser|chrom(e|ium)|playwright|puppeteer/i.test(name),
    ) ||
    manifest.scripts?.preinstall ||
    manifest.scripts?.install ||
    manifest.scripts?.postinstall
  ) {
    throw new Error(
      "packed extension has a runtime dependency, optional native dependency, or install script",
    );
  }

  const extension = await import(
    pathToFileURL(join(packageDirectory, "dist", "index.js")).href
  );
  const registered = [];
  extension.default({ registerTool: (tool) => registered.push(tool) });
  if (
    registered.map((tool) => tool.name).join(",") !==
    "web_search,web_fetch,web_links,web_docs,web_source_search"
  ) {
    throw new Error("packed extension did not register exactly five web tools");
  }

  const fakeBin = join(root, "fake-bin");
  await mkdir(fakeBin);
  const fakeLog = join(root, "agent-browser.log");
  await writeFile(
    join(fakeBin, "agent-browser"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify(args) + "\\n");
const command = args.at(-1) === "close" ? "close" : args.includes("eval") ? "eval" : "open";
if (command === "open" && args.some((value) => value.includes("/blocked"))) {
  console.log(JSON.stringify({ success: false, error: { message: "domain not allowed", hostname: "missing.cdn.test" } }));
  process.exit(1);
} else if (command === "eval") {
  console.log(JSON.stringify({ success: true, data: { result: JSON.stringify({ html: "<html><body><article><h1>Rendered fixture</h1><p>JavaScript output from fake agent-browser.</p></article></body></html>", url: "https://93.184.216.34/rendered" }) } }));
} else {
  console.log(JSON.stringify({ success: true, data: {} }));
}
`,
    { mode: 0o700 },
  );
  await chmod(join(fakeBin, "agent-browser"), 0o700);

  const originalFetch = globalThis.fetch;
  const originalExaKey = process.env.EXA_API_KEY;
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalCache = process.env.XDG_CACHE_HOME;
  process.env.EXA_API_KEY = "fixture-exa-key";
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  process.env.HOME = root;
  process.env.XDG_CACHE_HOME = join(root, "cache");
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === "https://93.184.216.34/direct")
      return new Response(
        "<html><body><article><h1>Direct fixture</h1><p>Browserless output.</p></article></body></html>",
        { headers: { "Content-Type": "text/html" } },
      );
    if (target === "https://93.184.216.34/links")
      return new Response(
        '<html><body><nav><a href="/destination">Packed link</a></nav></body></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    if (target !== "https://api.exa.ai/search")
      throw new Error(`unexpected fixture URL ${target}`);
    if (
      init.headers["x-api-key"] !== "fixture-exa-key" ||
      JSON.parse(init.body).query !== "packed search"
    )
      return new Response("bad search request", { status: 400 });
    return Response.json({
      results: [
        {
          title: "Packed search",
          url: "https://example.test/search",
          highlights: ["fixture"],
        },
      ],
    });
  };

  try {
    const searchTool = registered.find((tool) => tool.name === "web_search");
    if (!searchTool)
      throw new Error("packed extension did not register web_search");
    const search = await searchTool.execute("test", {
      queries: ["packed search"],
    });
    if (search.details.results[0]?.title !== "Packed search")
      throw new Error("packed extension could not execute its search tool");

    const fetchTool = registered.find((tool) => tool.name === "web_fetch");
    if (!fetchTool)
      throw new Error("packed extension did not register web_fetch");
    const direct = await fetchTool.execute("test", {
      url: "https://93.184.216.34/direct",
      full: true,
    });
    if (!direct.content[0]?.text.includes("Browserless output."))
      throw new Error("packed extension did not execute browserless fetch");
    try {
      await readFile(fakeLog, "utf8");
      throw new Error("browserless fetch unexpectedly launched agent-browser");
    } catch (error) {
      if (error instanceof Error && error.message.includes("unexpectedly"))
        throw error;
    }

    const linksTool = registered.find((tool) => tool.name === "web_links");
    if (!linksTool)
      throw new Error("packed extension did not register web_links");
    const links = await linksTool.execute("test", {
      url: "https://93.184.216.34/links",
    });
    if (links.details.links?.[0]?.url !== "https://93.184.216.34/destination")
      throw new Error("packed extension did not list browserless links");

    const rendered = await fetchTool.execute("test", {
      url: "https://93.184.216.34/rendered",
      render: "agent-browser",
      waitMs: 0,
      full: true,
    });
    if (
      !rendered.content[0]?.text.includes(
        "JavaScript output from fake agent-browser.",
      )
    )
      throw new Error("packed extension did not execute fake rendered fetch");
    const browserCommands = (await readFile(fakeLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const open = browserCommands[0];
    const allowed = open?.[open.indexOf("--allowed-domains") + 1];
    if (
      allowed !==
      ["93.184.216.34", "*.93.184.216.34", ...CDN_ALLOWLIST].join(",")
    )
      throw new Error("Pi packed renderer used an inconsistent CDN allowlist");
    if (
      browserCommands.length !== 3 ||
      browserCommands.at(-1)?.at(-1) !== "close"
    )
      throw new Error(
        "packed rendered fetch did not close its browser session",
      );

    try {
      await fetchTool.execute("test", {
        url: "https://93.184.216.34/blocked",
        render: "agent-browser",
        waitMs: 0,
      });
      throw new Error("blocked rendered fetch unexpectedly succeeded");
    } catch (error) {
      if (
        error?.details?.reportUrl !== REPORT_URL ||
        error?.details?.retryable !== false
      )
        throw new Error("Pi packed renderer lost the allowlist issue URL");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalExaKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = originalExaKey;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCache;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
