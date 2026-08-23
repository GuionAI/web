import {
  Client,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { FetchCapabilityError } from "@guionai/web-core";

import { createMcpServer } from "../src/mcp.js";
import type { WebOperations } from "@guionai/web-core";

function webService(): WebOperations {
  return {
    search: vi.fn(async () => ({
      provider: "Brave" as const,
      results: [
        {
          title: "MCP",
          link: "https://example.test/mcp",
          snippet: "Typed tools",
          position: 1,
        },
      ],
    })),
    fetch: vi.fn(async () => ({
      url: "https://example.test/page",
      mode: "tree" as const,
      content: "# Page",
    })),
    docsResolve: vi.fn(async () => ({
      query: "effect",
      libraries: [
        {
          id: "/effect-ts/effect",
          title: "Effect",
          description: "Typed effects",
          trust_score: 9.8,
          total_snippets: 42,
        },
      ],
    })),
    docsFetch: vi.fn(async () => ({
      library_id: "/effect-ts/effect",
      topic: "schema",
      content: "Effect docs",
    })),
    sgraphSearch: vi.fn(async () => ({ content: "# Sourcegraph results" })),
  };
}

function createDependencies(operations: WebOperations, provider?: string) {
  return {
    operations,
    provider,
    credentials: () => ({
      braveApiKey: "brave-secret",
      context7ApiKey: "context7-secret",
    }),
  };
}

async function connect(operations = webService(), provider?: string) {
  const server = createMcpServer(createDependencies(operations, provider));
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "web-test", version: "test" });
  await client.connect(clientTransport);
  return { client, operations };
}

async function connectStdio(operations = webService()) {
  const server = createMcpServer(createDependencies(operations));
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const serverTransport = new StdioServerTransport(
    clientToServer,
    serverToClient,
  );
  await server.connect(serverTransport);
  const clientTransport = new LoopbackStdioTransport(
    serverToClient,
    clientToServer,
  );
  const client = new Client({ name: "web-stdio-test", version: "test" });
  await client.connect(clientTransport);
  return {
    client,
    operations,
    close: async () => {
      await client.close();
      await serverTransport.close();
    },
  };
}

class LoopbackStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffer = "";

  constructor(
    private readonly input: PassThrough,
    private readonly output: PassThrough,
  ) {}

  start(): Promise<void> {
    this.input.on("data", this.handleData);
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.output.write(`${JSON.stringify(message)}\n`);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.input.off("data", this.handleData);
    this.onclose?.();
  }

  private handleData = (chunk: Buffer) => {
    this.buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error("invalid MCP message"),
        );
      }
    }
  };
}

describe("web stdio MCP adapter", () => {
  it("preserves fetch behavior and errors over serialized stdio", async () => {
    const operations = webService();
    vi.mocked(operations.fetch)
      .mockRejectedValueOnce(
        new FetchCapabilityError("javascript_rendering_may_be_required", {
          retryableWithRender: true,
          suggestedArguments: { render: "agent-browser", waitMs: 2000 },
        }),
      )
      .mockResolvedValueOnce({
        url: "https://example.test/page",
        mode: "full",
        content: "Rendered through stdio",
      });
    const connection = await connectStdio(operations);

    try {
      const retry = await connection.client.callTool({
        name: "fetch",
        arguments: { url: "https://example.test/page" },
      });
      const rendered = await connection.client.callTool({
        name: "fetch",
        arguments: {
          url: "https://example.test/page",
          render: "agent-browser",
          waitMs: 2000,
        },
      });

      expect(retry).toMatchObject({
        isError: true,
        structuredContent: {
          code: "javascript_rendering_may_be_required",
          details: {
            retryableWithRender: true,
            suggestedArguments: { render: "agent-browser", waitMs: 2000 },
          },
        },
      });
      expect(rendered.structuredContent).toMatchObject({
        content: "Rendered through stdio",
      });
      expect(operations.fetch).toHaveBeenNthCalledWith(
        2,
        {
          url: "https://example.test/page",
          tree: false,
          full: false,
          section_id: undefined,
          tree_threshold: 5000,
          render: "agent-browser",
          waitMs: 2000,
        },
        expect.any(AbortSignal),
      );
    } finally {
      await connection.close();
    }
  });

  it("lists exactly five typed read-only, idempotent, open-world tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "docs_fetch",
      "docs_resolve",
      "fetch",
      "search",
      "source_search",
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
    const fetchProperties = byName.fetch!.inputSchema.properties! as Record<
      string,
      unknown
    >;
    const docsFetchProperties = byName.docs_fetch!.inputSchema
      .properties! as Record<string, unknown>;
    const sgraphProperties = byName.source_search!.inputSchema
      .properties! as Record<string, unknown>;
    expect(fetchProperties.tree_threshold).toMatchObject({ default: 5000 });
    expect(fetchProperties.render).toMatchObject({
      enum: ["fetch", "agent-browser"],
      default: "fetch",
    });
    expect(fetchProperties.waitMs).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 30000,
    });
    expect(fetchProperties.timeout).toBeUndefined();
    expect(docsFetchProperties.tokens).toMatchObject({ default: 0 });
    expect(sgraphProperties).toMatchObject({
      count: { default: 10 },
      context: { default: 10 },
      timeout: { default: 0 },
    });
  });

  it("maps every input to the shared core and returns structured results", async () => {
    const { client, operations } = await connect(webService(), "brave");

    const search = await client.callTool({
      name: "search",
      arguments: { query: "typed mcp" },
    });
    const fetch = await client.callTool({
      name: "fetch",
      arguments: {
        url: "https://example.test/page",
        tree: true,
        render: "agent-browser",
        waitMs: 125,
      },
    });
    const resolve = await client.callTool({
      name: "docs_resolve",
      arguments: { query: "effect" },
    });
    const docs = await client.callTool({
      name: "docs_fetch",
      arguments: {
        library_id: "effect-ts/effect",
        topic: "schema",
        tokens: 1200,
      },
    });
    const sgraph = await client.callTool({
      name: "source_search",
      arguments: { query: "repo:guionai" },
    });

    expect(search.structuredContent).toMatchObject({ provider: "Brave" });
    expect(fetch.structuredContent).toMatchObject({ mode: "tree" });
    expect(resolve.structuredContent).toMatchObject({ query: "effect" });
    expect(docs.structuredContent).toMatchObject({ content: "Effect docs" });
    expect(sgraph.structuredContent).toMatchObject({
      content: "# Sourcegraph results",
    });
    expect(operations.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "typed mcp",
        provider: "brave",
        credentials: {
          braveApiKey: "brave-secret",
          context7ApiKey: "context7-secret",
        },
      }),
    );
    expect(operations.fetch).toHaveBeenCalledWith(
      {
        url: "https://example.test/page",
        tree: true,
        full: false,
        section_id: undefined,
        tree_threshold: 5000,
        render: "agent-browser",
        waitMs: 125,
      },
      expect.any(AbortSignal),
    );
    expect(operations.docsFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        library_id: "effect-ts/effect",
        topic: "schema",
        tokens: 1200,
      }),
    );
    expect(operations.sgraphSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "repo:guionai",
        count: 10,
        context: 10,
        timeout: 0,
      }),
    );
  });

  it("validates the renderer wait contract before invoking the core", async () => {
    const { client, operations } = await connect();
    await client.listTools();

    for (const arguments_ of [
      { url: "https://example.test/page", render: "agent-browser" },
      { url: "https://example.test/page", render: "fetch", waitMs: 0 },
      { url: "https://example.test/page", render: "agent-browser", waitMs: -1 },
      {
        url: "https://example.test/page",
        render: "agent-browser",
        waitMs: 30_001,
      },
      {
        url: "https://example.test/page",
        render: "agent-browser",
        waitMs: 1.5,
      },
    ]) {
      const result = await client.callTool({
        name: "fetch",
        arguments: arguments_,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject([
        {
          type: "text",
          text: expect.stringContaining("Input validation error"),
        },
      ]);
    }
    expect(operations.fetch).not.toHaveBeenCalled();
  });

  it("keeps fetch capability details structured and recovers after a renderer failure", async () => {
    const operations = webService();
    vi.mocked(operations.fetch)
      .mockRejectedValueOnce(
        new FetchCapabilityError("render_domain_not_allowed", {
          retryable: false,
          reportUrl: "https://github.com/guionai/web/issues/new",
          blockedHostname: "missing.cdn.test",
        }),
      )
      .mockResolvedValueOnce({
        url: "https://example.test/page",
        mode: "full",
        content: "Rendered page",
      });
    const { client } = await connect(operations);

    const failed = await client.callTool({
      name: "fetch",
      arguments: {
        url: "https://example.test/page",
        render: "agent-browser",
        waitMs: 2000,
      },
    });
    const recovered = await client.callTool({
      name: "fetch",
      arguments: { url: "https://example.test/page" },
    });

    expect(failed).toMatchObject({
      isError: true,
      structuredContent: {
        code: "render_domain_not_allowed",
        details: {
          retryable: false,
          reportUrl: "https://github.com/guionai/web/issues/new",
          blockedHostname: "missing.cdn.test",
        },
      },
    });
    expect(failed.content).toMatchObject([
      {
        type: "text",
        text: JSON.stringify({
          code: "render_domain_not_allowed",
          details: {
            retryable: false,
            reportUrl: "https://github.com/guionai/web/issues/new",
            blockedHostname: "missing.cdn.test",
          },
        }),
      },
    ]);
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({
      content: "Rendered page",
    });
  });

  it("keeps operations failures as tool errors and recovers for the next request", async () => {
    const operations = webService();
    vi.mocked(operations.search).mockImplementation(async ({ query }) => {
      if (query === "offline") throw new Error("brave-secret unavailable");
      return { provider: "Brave", results: [] };
    });
    const { client } = await connect(operations);

    const failed = await client.callTool({
      name: "search",
      arguments: { query: "offline" },
    });
    const recovered = await client.callTool({
      name: "search",
      arguments: { query: "working" },
    });

    expect(failed.isError).toBe(true);
    expect(failed.content).toMatchObject([
      { type: "text", text: "[redacted] unavailable" },
    ]);
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({
      provider: "Brave",
      results: [],
    });
  });

  it("leaves malformed tool input to MCP validation instead of invoking the core", async () => {
    const { client, operations } = await connect();
    await client.listTools();

    const result = await client.callTool({
      name: "search",
      arguments: { query: 42 },
    });
    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("Input validation error"),
        },
      ],
    });
    expect(operations.search).not.toHaveBeenCalled();
  });

  it("passes MCP cancellation into the shared core", async () => {
    const started = deferred<void>();
    const canceled = deferred<void>();
    const operations = webService();
    vi.mocked(operations.fetch).mockImplementation(
      (_input, signal) =>
        new Promise((_, reject) => {
          started.resolve();
          signal?.addEventListener(
            "abort",
            () => {
              canceled.resolve();
              reject(new Error("Operation aborted"));
            },
            { once: true },
          );
        }),
    );
    const { client } = await connect(operations);
    const controller = new AbortController();
    const call = client.callTool(
      {
        name: "fetch",
        arguments: {
          url: "https://example.test/page",
          render: "agent-browser",
          waitMs: 0,
        },
      },
      { signal: controller.signal },
    );

    await started.promise;
    controller.abort();
    await canceled.promise;
    await call.catch(() => undefined);
  });

  it("pins the selected provider for every search over a server lifetime", async () => {
    const { client, operations } = await connect(webService(), "exa");

    await client.callTool({ name: "search", arguments: { query: "first" } });
    await client.callTool({ name: "search", arguments: { query: "second" } });

    expect(operations.search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: "exa" }),
    );
    expect(operations.search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: "exa" }),
    );
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
