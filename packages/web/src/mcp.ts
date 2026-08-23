import {
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Command } from "commander";

import {
  FetchCapabilityError,
  RENDER_REPORT_URL,
  type FetchErrorDetails,
  type WebCredentials,
  type WebOperations,
} from "@guionai/web-core";

const DEFAULT_FETCH_TREE_THRESHOLD = 5000;

type SearchToolInput = { query: string };
type FetchToolInput = {
  url: string;
  tree?: boolean;
  section_id?: string;
  full?: boolean;
  tree_threshold?: number;
  render?: "fetch" | "agent-browser";
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
    tree: { type: "boolean", description: "show the page heading tree" },
    section_id: {
      type: "string",
      description: "optional heading section ID to return",
    },
    full: {
      type: "boolean",
      description: "return full content without automatic tree mode",
    },
    tree_threshold: {
      type: "integer",
      description: "automatic tree threshold; defaults to 5000",
      default: DEFAULT_FETCH_TREE_THRESHOLD,
    },
    render: {
      type: "string",
      enum: ["fetch", "agent-browser"],
      default: "fetch",
      description: "optional page-fetch backend; direct fetch is the default",
    },
    waitMs: {
      type: "integer",
      minimum: 0,
      maximum: 30_000,
      description:
        "required post-load wait for agent-browser rendering (0-30000)",
    },
  },
  required: ["url"],
  oneOf: [
    {
      properties: { render: { enum: ["fetch"] } },
      not: { required: ["waitMs"] },
    },
    {
      properties: { render: { const: "agent-browser" } },
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
    provider: { type: "string", enum: ["Exa", "Brave"] },
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

/** Creates the five-tool MCP server used by the stdio command and adapter tests. */
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
    "fetch",
    toolConfig(
      "Fetch a web page",
      "Use direct fetch (omit render or set render: fetch) for static, SSR, and pre-rendered pages. For client-rendered or SPA pages, set render: agent-browser with required waitMs on a host that has agent-browser installed; there is no automatic fallback.",
      fetchInputSchema,
      fetchOutputSchema,
    ),
    async (
      { url, tree, section_id, full, tree_threshold, render, waitMs },
      context,
    ) =>
      runTool(
        () =>
          dependencies.operations.fetch(
            {
              url,
              tree: tree ?? false,
              section_id,
              full: full ?? false,
              tree_threshold: tree_threshold ?? DEFAULT_FETCH_TREE_THRESHOLD,
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
    "sgraph_search",
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
    .option("--provider <provider>", "Search provider: exa or brave")
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
    details.suggestedArguments?.render === "agent-browser" &&
    details.suggestedArguments.waitMs === 2000
  ) {
    safe.suggestedArguments = { render: "agent-browser", waitMs: 2000 };
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
    credentials.context7ApiKey,
  ]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message;
}
