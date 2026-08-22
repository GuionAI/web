import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import { createMcpServer } from "../src/mcp.js";
import type { WebService } from "../src/program.js";

function webService(): WebService {
  return {
    search: vi.fn(async () => ({
      provider: "Brave" as const,
      results: [{ title: "MCP", link: "https://example.test/mcp", snippet: "Typed tools", position: 1 }],
    })),
    fetch: vi.fn(async () => ({ url: "https://example.test/page", mode: "tree" as const, content: "# Page" })),
    docsResolve: vi.fn(async () => ({
      query: "effect",
      libraries: [{ id: "/effect-ts/effect", title: "Effect", description: "Typed effects", trust_score: 9.8, total_snippets: 42 }],
    })),
    docsFetch: vi.fn(async () => ({ library_id: "/effect-ts/effect", topic: "schema", content: "Effect docs" })),
    sgraphSearch: vi.fn(async () => ({ content: "# Sourcegraph results" })),
  };
}

async function connect(service = webService(), provider?: string) {
  const server = createMcpServer({
    service,
    provider,
    credentials: () => ({ braveApiKey: "brave-secret", context7ApiKey: "context7-secret" }),
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "web-test", version: "test" });
  await client.connect(clientTransport);
  return { client, service };
}

describe("web stdio MCP adapter", () => {
  it("lists exactly five typed read-only, idempotent, open-world tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "docs_fetch", "docs_resolve", "fetch", "search", "sgraph_search",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }

    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const fetchProperties = byName.fetch!.inputSchema.properties! as Record<string, unknown>;
    const docsFetchProperties = byName.docs_fetch!.inputSchema.properties! as Record<string, unknown>;
    const sgraphProperties = byName.sgraph_search!.inputSchema.properties! as Record<string, unknown>;
    expect(fetchProperties.tree_threshold).toMatchObject({ default: 5000 });
    expect(docsFetchProperties.tokens).toMatchObject({ default: 0 });
    expect(sgraphProperties).toMatchObject({
      count: { default: 10 },
      context: { default: 10 },
      timeout: { default: 0 },
    });
  });

  it("maps every input to the shared core and returns structured results", async () => {
    const { client, service } = await connect(webService(), "brave");

    const search = await client.callTool({ name: "search", arguments: { query: "typed mcp" } });
    const fetch = await client.callTool({ name: "fetch", arguments: { url: "https://example.test/page", tree: true } });
    const resolve = await client.callTool({ name: "docs_resolve", arguments: { query: "effect" } });
    const docs = await client.callTool({
      name: "docs_fetch",
      arguments: { library_id: "effect-ts/effect", topic: "schema", tokens: 1200 },
    });
    const sgraph = await client.callTool({ name: "sgraph_search", arguments: { query: "repo:guionai" } });

    expect(search.structuredContent).toMatchObject({ provider: "Brave" });
    expect(fetch.structuredContent).toMatchObject({ mode: "tree" });
    expect(resolve.structuredContent).toMatchObject({ query: "effect" });
    expect(docs.structuredContent).toMatchObject({ content: "Effect docs" });
    expect(sgraph.structuredContent).toMatchObject({ content: "# Sourcegraph results" });
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({
      query: "typed mcp",
      provider: "brave",
      credentials: { braveApiKey: "brave-secret", context7ApiKey: "context7-secret" },
    }));
    expect(service.fetch).toHaveBeenCalledWith({
      url: "https://example.test/page",
      tree: true,
      full: false,
      section_id: undefined,
      tree_threshold: 5000,
    }, expect.any(AbortSignal));
    expect(service.docsFetch).toHaveBeenCalledWith(expect.objectContaining({
      library_id: "effect-ts/effect",
      topic: "schema",
      tokens: 1200,
    }));
    expect(service.sgraphSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: "repo:guionai",
      count: 10,
      context: 10,
      timeout: 0,
    }));
  });

  it("keeps service failures as tool errors and recovers for the next request", async () => {
    const service = webService();
    vi.mocked(service.search).mockImplementation(async ({ query }) => {
      if (query === "offline") throw new Error("brave-secret unavailable");
      return { provider: "Brave", results: [] };
    });
    const { client } = await connect(service);

    const failed = await client.callTool({ name: "search", arguments: { query: "offline" } });
    const recovered = await client.callTool({ name: "search", arguments: { query: "working" } });

    expect(failed.isError).toBe(true);
    expect(failed.content).toMatchObject([{ type: "text", text: "[redacted] unavailable" }]);
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({ provider: "Brave", results: [] });
  });

  it("leaves malformed tool input to MCP validation instead of invoking the core", async () => {
    const { client, service } = await connect();
    await client.listTools();

    const result = await client.callTool({ name: "search", arguments: { query: 42 } });
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("Input validation error") }],
    });
    expect(service.search).not.toHaveBeenCalled();
  });

  it("passes MCP cancellation into the shared core", async () => {
    const started = deferred<void>();
    const canceled = deferred<void>();
    const service = webService();
    vi.mocked(service.search).mockImplementation(({ signal }) => new Promise((_, reject) => {
      started.resolve();
      signal?.addEventListener("abort", () => {
        canceled.resolve();
        reject(new Error("Operation aborted"));
      }, { once: true });
    }));
    const { client } = await connect(service);
    const controller = new AbortController();
    const call = client.callTool({ name: "search", arguments: { query: "wait" } }, { signal: controller.signal });

    await started.promise;
    controller.abort();
    await canceled.promise;
    await call.catch(() => undefined);
  });

  it("pins the selected provider for every search over a server lifetime", async () => {
    const { client, service } = await connect(webService(), "exa");

    await client.callTool({ name: "search", arguments: { query: "first" } });
    await client.callTool({ name: "search", arguments: { query: "second" } });

    expect(service.search).toHaveBeenNthCalledWith(1, expect.objectContaining({ provider: "exa" }));
    expect(service.search).toHaveBeenNthCalledWith(2, expect.objectContaining({ provider: "exa" }));
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
