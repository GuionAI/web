import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "guionai-web-pack-smoke-"));
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
  if (request.url !== "/page") {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(
    "<html><body><article><p>Packed fetch fixture.</p></article></body></html>",
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
  if (JSON.stringify(installedManifest.bin) !== '{"web":"./dist/cli.js"}')
    throw new Error(
      "packed web package does not expose only the web executable",
    );

  const binary = join(root, "node_modules", ".bin", "web");
  const help = await execFileAsync(binary, ["--help"], { cwd: root });
  if (!help.stdout.includes("Search the web") || !help.stdout.includes("mcp"))
    throw new Error("installed web CLI did not start with its MCP command");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binary, "mcp"],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
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
        "search",
        "sgraph_search",
      ])
    ) {
      throw new Error(`packed MCP tools = ${names.join(", ")}`);
    }

    const mcpFetch = await client.callTool({
      name: "fetch",
      arguments: { url: `http://127.0.0.1:${port}/page`, full: true },
    });
    if (
      mcpFetch.isError ||
      mcpFetch.structuredContent?.mode !== "full" ||
      mcpFetch.structuredContent?.content !== "Packed fetch fixture.\n"
    ) {
      throw new Error("packed MCP stdio could not fetch the local fixture");
    }

    const result = await execFileAsync(
      binary,
      ["fetch", `http://127.0.0.1:${port}/page`, "--full", "--json"],
      { cwd: root },
    );
    const fetched = JSON.parse(result.stdout);
    if (
      fetched.mode !== "full" ||
      fetched.content !== "Packed fetch fixture.\n"
    ) {
      throw new Error("installed web CLI could not fetch the local fixture");
    }
  } finally {
    await client.close();
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
