import { execFile } from "node:child_process";
import { createServer } from "node:http";
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
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "guionai-web-pack-smoke-"));
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
      HOME: join(root, "home"),
      XDG_CACHE_HOME: join(root, "cache"),
      npm_config_store_dir: join(root, "store"),
      npm_config_ignore_scripts: "true",
    },
  });
}

const server = createServer((request, response) => {
  if (request.url !== "/page" && request.url !== "/links") {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(
    request.url === "/links"
      ? '<html><body><nav><a href="/destination">Packed link</a></nav></body></html>'
      : "<html><body><article><p>Packed fetch fixture.</p></article></body></html>",
  );
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
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
    throw new Error("web tarball contains browser or platform artifacts");

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "pack-smoke", private: true }),
  );
  await pnpm(["add", "--offline", "--ignore-scripts", `file:${tarball}`], root);

  const installedManifest = JSON.parse(
    await readFile(
      join(root, "node_modules", "@guionai", "web", "package.json"),
      "utf8",
    ),
  );
  if (installedManifest.exports || installedManifest.main)
    throw new Error("packed web package exposes a root JavaScript entry");
  if (
    installedManifest.scripts?.preinstall ||
    installedManifest.scripts?.install ||
    installedManifest.scripts?.postinstall ||
    Object.keys(installedManifest.optionalDependencies ?? {}).length > 0 ||
    Object.keys(installedManifest.dependencies ?? {}).some((name) =>
      /agent-browser|chrom(e|ium)|playwright|puppeteer/i.test(name),
    )
  )
    throw new Error(
      "packed web package adds browser infrastructure or an install hook",
    );
  if (JSON.stringify(installedManifest.bin) !== '{"web":"./dist/cli.js"}')
    throw new Error(
      "packed web package does not expose only the web executable",
    );

  const binary = join(root, "node_modules", ".bin", "web");
  const help = await execFileAsync(binary, ["--help"], { cwd: root });
  if (!help.stdout.includes("Search the web") || !help.stdout.includes("mcp"))
    throw new Error("installed web CLI did not start with its MCP command");

  const fakeBin = join(root, "fake-browser-bin");
  const fakeLog = join(root, "agent-browser.jsonl");
  await mkdir(fakeBin);
  await writeFile(
    join(fakeBin, "agent-browser"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const command = args.includes("close") ? "close" : args.includes("eval") ? "eval" : "open";
appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify(args) + "\\n");
if (command === "open" && args.some((value) => value.includes("/blocked"))) {
  console.log(JSON.stringify({ success: false, error: { message: "domain not allowed", hostname: "missing.cdn.test" } }));
  process.exit(1);
}
if (command === "eval")
  console.log(JSON.stringify({ success: true, data: { result: JSON.stringify({ html: "<html><body><article><p>Packed rendered fixture.</p></article></body></html>", url: "https://93.184.216.34/rendered" }) } }));
else console.log(JSON.stringify({ success: true, data: {} }));
`,
  );
  await chmod(join(fakeBin, "agent-browser"), 0o700);
  const fakeEnvironment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    HOME: join(root, "render-home"),
    XDG_CACHE_HOME: join(root, "render-cache"),
  };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binary, "mcp"],
    cwd: root,
    env: {
      PATH: join(root, "no-browser-bin"),
      HOME: join(root, "mcp-home"),
      XDG_CACHE_HOME: join(root, "mcp-cache"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "packed-web-mcp-smoke", version: "test" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    if (
      JSON.stringify(names) !==
      JSON.stringify([
        "docs_fetch",
        "docs_resolve",
        "fetch",
        "links",
        "search",
        "source_search",
      ])
    ) {
      throw new Error(`packed MCP tools = ${names.join(", ")}`);
    }

    const mcpFetch = await client.callTool({
      name: "fetch",
      arguments: { url: `http://127.0.0.1:${port}/page`, mode: "full" },
    });
    if (
      mcpFetch.isError ||
      mcpFetch.structuredContent?.mode !== "full" ||
      mcpFetch.structuredContent?.truncated !== false ||
      mcpFetch.structuredContent?.content !== "Packed fetch fixture.\n"
    ) {
      throw new Error("packed MCP stdio could not fetch the local fixture");
    }

    const mcpLinks = await client.callTool({
      name: "links",
      arguments: { url: `http://127.0.0.1:${port}/links` },
    });
    if (
      mcpLinks.isError ||
      mcpLinks.structuredContent?.links?.[0]?.url !==
        `http://127.0.0.1:${port}/destination`
    ) {
      throw new Error("packed MCP stdio could not list local links");
    }

    const result = await execFileAsync(
      binary,
      ["fetch", `http://127.0.0.1:${port}/page`, "--mode", "full", "--json"],
      { cwd: root },
    );
    const fetched = JSON.parse(result.stdout);
    if (
      fetched.mode !== "full" ||
      fetched.truncated !== false ||
      fetched.content !== "Packed fetch fixture.\n"
    ) {
      throw new Error("installed web CLI could not fetch the local fixture");
    }

    const linkResult = await execFileAsync(
      binary,
      ["links", `http://127.0.0.1:${port}/links`, "--json"],
      { cwd: root },
    );
    if (
      JSON.parse(linkResult.stdout).links?.[0]?.url !==
      `http://127.0.0.1:${port}/destination`
    ) {
      throw new Error("installed web CLI could not list local links");
    }
  } finally {
    await client.close();
  }

  const rendered = await execFileAsync(
    binary,
    [
      "fetch",
      "https://93.184.216.34/rendered",
      "--render=browser",
      "--wait=0",
      "--mode",
      "full",
      "--json",
    ],
    { cwd: root, env: fakeEnvironment },
  );
  if (JSON.parse(rendered.stdout).content !== "Packed rendered fixture.\n")
    throw new Error("installed web CLI could not execute fake rendering");
  const browserCommands = (await readFile(fakeLog, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const open = browserCommands[0];
  const allowed = open?.[open.indexOf("--allowed-domains") + 1];
  if (
    allowed !== ["93.184.216.34", "*.93.184.216.34", ...CDN_ALLOWLIST].join(",")
  )
    throw new Error("web packed renderer used an inconsistent CDN allowlist");
  if (
    browserCommands.length !== 3 ||
    browserCommands.at(-1)?.at(-1) !== "close"
  )
    throw new Error("web packed renderer did not close its session");

  try {
    await execFileAsync(
      binary,
      [
        "fetch",
        "https://93.184.216.34/blocked",
        "--render=browser",
        "--wait=0",
      ],
      { cwd: root, env: fakeEnvironment },
    );
    throw new Error("blocked rendered fetch unexpectedly succeeded");
  } catch (error) {
    if (!String(error.stderr ?? "").includes(REPORT_URL))
      throw new Error("web packed renderer lost the allowlist issue URL");
    if (!String(error.stderr).includes("increasing --wait will not help"))
      throw new Error(
        "web packed renderer offered wait retry for a blocked domain",
      );
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
