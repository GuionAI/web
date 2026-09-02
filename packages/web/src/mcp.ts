import {
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Command } from "commander";

import {
  DEFAULT_LINK_LIMIT,
  FETCH_MODES,
  FetchCapabilityError,
  MAX_LINK_LIMIT,
  RENDER_REPORT_URL,
  type FetchMode,
  type FetchErrorDetails,
  type WebCredentials,
  type WebOperations,
} from "@guionai/web-core";

type SearchToolInput = { query: string };
type FetchToolInput = {
  url: string;
  mode?: FetchMode;
  section_id?: string;
  render?: "http" | "browser";
  waitMs?: number;
};
type LinksToolInput = {
  url: string;
  limit?: number;
  render?: "http" | "browser";
  waitMs?: number;
};
type DocsResolveToolInput = { query: string };
type DocsFetchToolInput = {
  library_id: string;
  topic?: string;
  tokens?: number;
};
type SGraphToolInput = {
  query: string;
  count?: number;
  context?: number;
  timeout?: number;
};

export type McpDependencies = {
  operations: WebOperations;
  credentials: () => WebCredentials;
  /** A provider selected at startup and used by every search request. */
  provider?: string;
};

const searchInputSchema = schema<SearchToolInput>({
  type: "object",
  properties: { query: { type: "string", description: "web search query" } },
  required: ["query"],
});
const fetchInputSchema = schema<FetchToolInput>({
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", description: "HTTP or HTTPS URL to fetch" },
    mode: {
      type: "string",
      enum: [...FETCH_MODES],
      default: "auto",
      description: "navigation mode: auto (default), full, tree, or section",
    },
    section_id: {
      type: "string",
      minLength: 1,
      pattern: "\\S",
      description: "heading section ID; required only with mode section",
    },
    render: {
      type: "string",
      enum: ["http", "browser"],
      default: "http",
      description: "optional page renderer; HTTP fetching is the default",
    },
    waitMs: {
      type: "integer",
      minimum: 0,
      maximum: 30_000,
      description: "required post-load wait for browser rendering (0-30000)",
    },
  },
  required: ["url"],
  oneOf: [
    {
      properties: { render: { enum: ["http"] } },
      not: { required: ["waitMs"] },
    },
    {
      properties: { render: { const: "browser" } },
      required: ["render", "waitMs"],
    },
  ],
  allOf: [
    {
      oneOf: [
        {
          properties: {
            mode: { enum: FETCH_MODES.filter((mode) => mode !== "section") },
          },
          not: { required: ["section_id"] },
        },
        {
          properties: { mode: { const: "section" } },
          required: ["mode", "section_id"],
        },
      ],
    },
  ],
});
const linksInputSchema = schema<LinksToolInput>({
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", description: "HTTP or HTTPS URL to inspect" },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LINK_LIMIT,
      default: DEFAULT_LINK_LIMIT,
      description: "maximum links to return",
    },
    render: {
      type: "string",
      enum: ["http", "browser"],
      default: "http",
      description: "optional page renderer; HTTP fetching is the default",
    },
    waitMs: {
      type: "integer",
      minimum: 0,
      maximum: 30_000,
      description: "required post-load wait for browser rendering (0-30000)",
    },
  },
  required: ["url"],
  oneOf: [
    {
      properties: { render: { enum: ["http"] } },
      not: { required: ["waitMs"] },
    },
    {
      properties: { render: { const: "browser" } },
      required: ["render", "waitMs"],
    },
  ],
});
const docsResolveInputSchema = schema<DocsResolveToolInput>({
  type: "object",
  properties: {
    query: { type: "string", description: "library name or package query" },
  },
  required: ["query"],
});
const docsFetchInputSchema = schema<DocsFetchToolInput>({
  type: "object",
  properties: {
    library_id: {
      type: "string",
      description: "Context7 library ID returned by docs_resolve",
    },
    topic: { type: "string", description: "optional documentation topic" },
    tokens: {
      type: "integer",
      description: "optional token budget; zero uses the backend default",
      default: 0,
    },
  },
  required: ["library_id"],
});
const sgraphInputSchema = schema<SGraphToolInput>({
  type: "object",
  properties: {
    query: { type: "string", description: "Sourcegraph search query" },
    count: {
      type: "integer",
      description: "optional result count; defaults to 10",
      default: 10,
    },
    context: {
      type: "integer",
      description: "optional context lines; defaults to 10",
      default: 10,
    },
    timeout: {
      type: "integer",
      description: "optional timeout in seconds; zero disables the timeout",
      default: 0,
    },
  },
  required: ["query"],
});

const searchOutputSchema = schema({
  type: "object",
  properties: {
    provider: {
      type: "string",
      enum: ["Exa", "Brave", "DeepSeek", "Kepos Bridge"],
    },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          link: { type: "string" },
          snippet: { type: "string" },
          position: { type: "integer" },
        },
        required: ["title", "link", "snippet", "position"],
      },
    },
  },
  required: ["provider", "results"],
});
const fetchOutputSchema = schema({
  type: "object",
  properties: {
    url: { type: "string" },
    mode: { type: "string", enum: ["full", "tree", "section"] },
    content: { type: "string" },
  },
  required: ["url", "mode", "content"],
});
const linksOutputSchema = schema({
  type: "object",
  properties: {
    url: { type: "string" },
    links: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          url: { type: "string" },
        },
        required: ["text", "url"],
      },
    },
    truncated: { type: "boolean" },
  },
  required: ["url", "links", "truncated"],
});
const docsResolveOutputSchema = schema({
  type: "object",
  properties: {
    query: { type: "string" },
    libraries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          trust_score: { type: "number" },
          total_snippets: { type: "integer" },
          versions: { type: "array", items: { type: "string" } },
        },
        required: [
          "id",
          "title",
          "description",
          "trust_score",
          "total_snippets",
        ],
      },
    },
  },
  required: ["query", "libraries"],
});
const docsFetchOutputSchema = schema({
  type: "object",
  properties: {
    library_id: { type: "string" },
    topic: { type: "string" },
    content: { type: "string" },
  },
  required: ["library_id", "content"],
});
const sgraphOutputSchema = schema({
  type: "object",
  properties: { content: { type: "string" } },
  required: ["content"],
});

/** Creates the six-tool MCP server used by the stdio command and adapter tests. */
export function createMcpServer(dependencies: McpDependencies): McpServer {
  const server = new McpServer({ name: "guionai-web", version: "0.1.0" });

  server.registerTool(
    "search",
    toolConfig(
      "Search the web",
      "Search the web and return the selected provider with ranked results.",
      searchInputSchema,
      searchOutputSchema,
    ),
    async ({ query }, context) =>
      runTool(
        () =>
          dependencies.operations.search({
            query,
            provider: dependencies.provider,
            credentials: dependencies.credentials(),
            signal: context.mcpReq.signal,
          }),
        dependencies.credentials(),
      ),
  );

  server.registerTool(
    "links",
    toolConfig(
      "List page links",
      "List HTTP or HTTPS links from an HTTP or browser-rendered page.",
      linksInputSchema,
      linksOutputSchema,
    ),
    async ({ url, limit, render, waitMs }, context) =>
      runTool(
        () =>
          dependencies.operations.links(
            {
              url,
              ...(limit !== undefined ? { limit } : {}),
              ...(render !== undefined ? { render } : {}),
              ...(waitMs !== undefined ? { waitMs } : {}),
            },
            context.mcpReq.signal,
          ),
        dependencies.credentials(),
      ),
  );

  server.registerTool(
    "fetch",
    toolConfig(
      "Fetch a web page",
      "Use the default HTTP renderer for static, SSR, and pre-rendered pages. For client-rendered or SPA pages, set render: browser with required waitMs when the host provides browser capability; there is no automatic fallback.",
      fetchInputSchema,
      fetchOutputSchema,
    ),
    async ({ url, mode, section_id, render, waitMs }, context) =>
      runTool(
        () =>
          dependencies.operations.fetch(
            {
              url,
              ...(mode !== undefined ? { mode } : {}),
              ...(section_id !== undefined ? { section_id } : {}),
              ...(render !== undefined ? { render } : {}),
              ...(waitMs !== undefined ? { waitMs } : {}),
            },
            context.mcpReq.signal,
          ),
        dependencies.credentials(),
      ),
  );

  server.registerTool(
    "docs_resolve",
    toolConfig(
      "Resolve a documentation library",
      "Resolve a library or package query to typed Context7 library IDs.",
      docsResolveInputSchema,
      docsResolveOutputSchema,
    ),
    async ({ query }, context) =>
      runTool(
        () =>
          dependencies.operations.docsResolve({
            query,
            credentials: dependencies.credentials(),
            signal: context.mcpReq.signal,
          }),
        dependencies.credentials(),
      ),
  );

  server.registerTool(
    "docs_fetch",
    toolConfig(
      "Fetch library documentation",
      "Fetch documentation for a Context7 library ID and optional topic.",
      docsFetchInputSchema,
      docsFetchOutputSchema,
    ),
    async ({ library_id, topic, tokens }, context) =>
      runTool(
        () =>
          dependencies.operations.docsFetch({
            library_id,
            topic,
            tokens: tokens ?? 0,
            credentials: dependencies.credentials(),
            signal: context.mcpReq.signal,
          }),
        dependencies.credentials(),
      ),
  );

  server.registerTool(
    "source_search",
    toolConfig(
      "Search public source code",
      "Search public source code through Sourcegraph and return Markdown results.",
      sgraphInputSchema,
      sgraphOutputSchema,
    ),
    async ({ query, count, context: contextWindow, timeout }, context) =>
      runTool(
        () =>
          dependencies.operations.sgraphSearch({
            query,
            count: count ?? 10,
            context: contextWindow ?? 10,
            timeout: timeout ?? 0,
            signal: context.mcpReq.signal,
          }),
        dependencies.credentials(),
      ),
  );

  return server;
}

/** Adds the process-lifetime stdio MCP command to the CLI. */
export function createMcpCommand(
  dependencies: Omit<McpDependencies, "provider">,
): Command {
  return new Command("mcp")
    .description("Serve typed web tools over stdio MCP")
    .option(
      "--provider <provider>",
      "Search provider: exa, brave, deepseek, or kepos-bridge",
    )
    .action((options: { provider?: string }) => {
      const provider = options.provider;
      serveStdio(() => createMcpServer({ ...dependencies, provider }), {
        onerror: (error) =>
          process.stderr.write(`MCP transport error: ${error.message}\n`),
      });
    });
}

function schema<T>(value: JsonSchemaType) {
  return fromJsonSchema<T>(value);
}

function toolConfig<Input, Output>(
  title: string,
  description: string,
  inputSchema: ReturnType<typeof schema<Input>>,
  outputSchema: ReturnType<typeof schema<Output>>,
) {
  return {
    title,
    description,
    inputSchema,
    outputSchema,
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  };
}

async function runTool<T extends Record<string, unknown>>(
  operation: () => Promise<T>,
  credentials: WebCredentials,
): Promise<CallToolResult> {
  try {
    const result = await operation();
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    if (error instanceof FetchCapabilityError) {
      const structured = {
        code: error.code,
        details: safeFetchErrorDetails(error.details),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structured) }],
        structuredContent: structured,
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: redactError(error, credentials) }],
      isError: true,
    };
  }
}

function safeFetchErrorDetails(details: FetchErrorDetails): FetchErrorDetails {
  const safe: FetchErrorDetails = {};
  if (typeof details.retryableWithRender === "boolean")
    safe.retryableWithRender = details.retryableWithRender;
  if (typeof details.retryable === "boolean")
    safe.retryable = details.retryable;
  if (
    details.suggestedArguments?.render === "browser" &&
    details.suggestedArguments.waitMs === 2000
  ) {
    safe.suggestedArguments = { render: "browser", waitMs: 2000 };
  }
  if (details.reportUrl === RENDER_REPORT_URL)
    safe.reportUrl = details.reportUrl;
  if (
    typeof details.blockedHostname === "string" &&
    isSafeHostname(details.blockedHostname)
  ) {
    safe.blockedHostname = details.blockedHostname.toLowerCase();
  }
  return safe;
}

function isSafeHostname(hostname: string): boolean {
  return (
    hostname.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) &&
    !hostname.includes("..")
  );
}

function redactError(error: unknown, credentials: WebCredentials): string {
  let message = error instanceof Error ? error.message : "web operation failed";
  for (const secret of [
    credentials.exaApiKey,
    credentials.braveApiKey,
    credentials.deepseekApiKey,
    credentials.context7ApiKey,
  ]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message;
}
