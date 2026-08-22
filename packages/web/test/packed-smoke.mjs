import { execFile } from "node:child_process";
import { createServer } from "node:http";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

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

let notifySlowRequestAborted;
const server = createServer((request, response) => {
  if (request.url === "/graphql") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (
        request.method !== "POST" ||
        JSON.parse(body).variables?.query !== "packed code fixture"
      ) {
        response.statusCode = 400;
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: {
            search: { results: { matchCount: 0, resultCount: 0, results: [] } },
          },
        }),
      );
    });
    return;
  }
  if (request.url === "/page") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      "<html><body><article><p>Packed fetch fixture.</p></article></body></html>",
    );
    return;
  }
  if (request.url === "/slow") {
    request.once("aborted", () => {
      notifySlowRequestAborted?.();
    });
    response.once("close", () => {
      notifySlowRequestAborted?.();
    });
    return;
  }
  if (request.url.startsWith("/api/v1/search")) {
    if (
      request.headers.authorization !== "Bearer fixture-context7-key" ||
      new URL(request.url, "http://fixture.test").searchParams.get("query") !==
        "react"
    ) {
      response.statusCode = 400;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        results: [
          {
            id: "/reactjs/react.dev",
            title: "React",
            description: "fixture",
            trustScore: 10,
            totalSnippets: 1,
          },
        ],
      }),
    );
    return;
  }
  if (
    request.url === "/api/v1/reactjs/react.dev?type=txt&topic=hooks&tokens=50"
  ) {
    if (request.headers.authorization !== "Bearer fixture-context7-key") {
      response.statusCode = 401;
      response.end();
      return;
    }
    response.end("Packed Context7 documentation");
    return;
  }
  if (request.url !== "/search") {
    response.statusCode = 404;
    response.end();
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    if (
      request.headers["x-api-key"] !== "fixture-key" ||
      JSON.parse(body).query !== "packed fixture"
    ) {
      response.statusCode = 400;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        results: [
          {
            title: "Packed result",
            url: "https://example.test",
            highlights: ["local fixture"],
          },
        ],
      }),
    );
  });
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
  if (JSON.stringify(installedManifest).includes("workspace:"))
    throw new Error("packed manifest contains workspace protocol");

  const installed = await import(
    pathToFileURL(
      join(root, "node_modules", "@guionai", "web", "dist", "index.js"),
    ).href
  );
  const result = await installed.search({
    query: "packed fixture",
    credentials: { exaApiKey: "fixture-key" },
    endpoints: { exa: `http://127.0.0.1:${port}` },
  });
  if (
    result.provider !== "Exa" ||
    result.results[0]?.title !== "Packed result"
  ) {
    throw new Error("installed package could not search the local fixture");
  }
  const docs = await installed.docsResolve({
    query: "react",
    credentials: { context7ApiKey: "fixture-context7-key" },
    endpoint: `http://127.0.0.1:${port}`,
  });
  if (docs.libraries[0]?.id !== "/reactjs/react.dev")
    throw new Error("installed package could not resolve Context7 docs");
  const documentation = await installed.docsFetch({
    library_id: "reactjs/react.dev",
    topic: "hooks",
    tokens: 50,
    credentials: { context7ApiKey: "fixture-context7-key" },
    endpoint: `http://127.0.0.1:${port}`,
  });
  if (documentation.content !== "Packed Context7 documentation")
    throw new Error("installed package could not fetch Context7 docs");
  const codeSearch = await installed.sgraphSearch({
    query: "packed code fixture",
    endpoint: `http://127.0.0.1:${port}/graphql`,
  });
  if (!codeSearch.content.includes("No results found"))
    throw new Error(
      "installed package could not search the local Sourcegraph fixture",
    );

  const binary = join(root, "node_modules", ".bin", "web");
  const { stdout } = await execFileAsync(binary, ["--help"], { cwd: root });
  if (!stdout.includes("Search the web") || !stdout.includes("sgraph"))
    throw new Error("installed web CLI did not expose Sourcegraph search");

  const fetched = await execFileAsync(
    binary,
    ["fetch", `http://127.0.0.1:${port}/page`, "--full", "--json"],
    { cwd: root },
  );
  const fetchedResult = JSON.parse(fetched.stdout);
  if (
    fetchedResult.mode !== "full" ||
    fetchedResult.content !== "Packed fetch fixture.\n"
  ) {
    throw new Error("installed web CLI could not fetch the local fixture");
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binary, "mcp", "--provider", "exa"],
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
    for (const tool of tools) {
      if (
        !tool.inputSchema ||
        !tool.outputSchema ||
        !tool.annotations?.readOnlyHint ||
        !tool.annotations.idempotentHint ||
        tool.annotations.openWorldHint !== true
      ) {
        throw new Error(
          `packed MCP tool metadata is incomplete for ${tool.name}`,
        );
      }
    }
    const toolByName = Object.fromEntries(
      tools.map((tool) => [tool.name, tool]),
    );
    if (
      toolByName.fetch.inputSchema.properties.tree_threshold.default !== 5000 ||
      toolByName.docs_fetch.inputSchema.properties.tokens.default !== 0 ||
      toolByName.sgraph_search.inputSchema.properties.count.default !== 10 ||
      toolByName.sgraph_search.inputSchema.properties.context.default !== 10 ||
      toolByName.sgraph_search.inputSchema.properties.timeout.default !== 0
    ) {
      throw new Error("packed MCP tool defaults are incorrect");
    }

    const success = await client.callTool({
      name: "fetch",
      arguments: { url: `http://127.0.0.1:${port}/page`, full: true },
    });
    if (
      success.isError ||
      success.structuredContent.content !== "Packed fetch fixture.\n"
    ) {
      throw new Error(
        "packed MCP server could not return a structured fetch result",
      );
    }
    const providerFailure = await client.callTool({
      name: "search",
      arguments: { query: "no live provider" },
    });
    if (
      !providerFailure.isError ||
      providerFailure.content[0]?.text !==
        "EXA_API_KEY is required when --provider exa is selected"
    ) {
      throw new Error(
        "packed MCP --provider did not pin Exa for the server lifetime",
      );
    }
    const recovered = await client.callTool({
      name: "fetch",
      arguments: { url: `http://127.0.0.1:${port}/page`, full: true },
    });
    if (recovered.isError)
      throw new Error("packed MCP server did not recover after a tool error");

    const slowRequestClosed = new Promise((resolve) => {
      notifySlowRequestAborted = resolve;
    });
    const controller = new AbortController();
    const slowCall = client.callTool(
      {
        name: "fetch",
        arguments: { url: `http://127.0.0.1:${port}/slow`, full: true },
      },
      { signal: controller.signal },
    );
    const ignoredSlowCall = slowCall.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await slowRequestClosed;
    await ignoredSlowCall;
  } finally {
    await client.close();
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
