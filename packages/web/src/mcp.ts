import {
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Command } from "commander";

import type { WebCredentials, WebOperations } from "@guionai/web-core";

const DEFAULT_FETCH_TREE_THRESHOLD = 5000;

type SearchToolInput = { query: string };
type FetchToolInput = {
  url: string;
  tree?: boolean;
  section_id?: string;
  full?: boolean;
  tree_threshold?: number;
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
  },
  required: ["url"],
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
      "Fetch a web page and return rendered Markdown content.",
      fetchInputSchema,
      fetchOutputSchema,
    ),
    async ({ url, tree, section_id, full, tree_threshold }, context) =>
      runTool(
        () =>
          dependencies.operations.fetch(
            {
              url,
              tree: tree ?? false,
              section_id,
              full: full ?? false,
              tree_threshold: tree_threshold ?? DEFAULT_FETCH_TREE_THRESHOLD,
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
    return {
      content: [{ type: "text", text: redactError(error, credentials) }],
      isError: true,
    };
  }
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
