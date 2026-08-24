import {
  createWebOperations,
  DEFAULT_LINK_LIMIT,
  normalizeDocsToolInput,
  formatSize,
  MAX_LINK_LIMIT,
  truncateHead,
  type Context7Credentials,
  type DocsFetchResult,
  type DocsResolveResult,
  type DocsToolInput,
  type FetchResult,
  type LinksInput,
  type LinksResult,
  type SGraphResult,
  type WebOperations,
} from "@guionai/web-core";
import {
  credentialRef,
  type CredentialRef,
  type ResolvedCredential,
} from "@deepseek-ai/dsh-credentials";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";

import { CONTEXT7_CREDENTIAL_REF } from "./contract.js";

const DEFAULT_TREE_THRESHOLD = 5000;

export interface WebToolDependencies {
  credentials: {
    resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
  };
  operations?: WebOperations;
}

const fetchParameters = {
  url: {
    type: "string",
    required: true,
    description: "HTTP or HTTPS URL to fetch",
  },
  tree: { type: "boolean", description: "Show the page heading tree" },
  section_id: {
    type: "string",
    description: "Optional heading section ID to return",
  },
  full: {
    type: "boolean",
    description: "Return full content without automatic tree mode",
  },
  tree_threshold: {
    type: "integer",
    default: DEFAULT_TREE_THRESHOLD,
    description: "Automatic tree threshold; defaults to 5000",
  },
  render: {
    type: "string",
    enum: ["fetch", "agent-browser"],
    description: "Page-fetch backend; defaults to direct fetch",
  },
  waitMs: {
    type: "integer",
    description:
      "Required post-load wait for agent-browser rendering (0-30000)",
  },
} as const;

const linksParameters = {
  url: {
    type: "string",
    required: true,
    description: "HTTP or HTTPS URL to inspect",
  },
  limit: {
    type: "integer",
    default: DEFAULT_LINK_LIMIT,
    description: `Maximum links to return (1-${MAX_LINK_LIMIT})`,
  },
  render: {
    type: "string",
    enum: ["fetch", "agent-browser"],
    description: "Page-fetch backend; defaults to direct fetch",
  },
  waitMs: {
    type: "integer",
    description:
      "Required post-load wait for agent-browser rendering (0-30000)",
  },
} as const;

const docsParameters = {
  action: {
    type: "string",
    enum: ["resolve", "fetch"],
    required: true,
    description: "Documentation operation",
  },
  query: { type: "string", description: "Library name or package query" },
  library_id: {
    type: "string",
    description: "Context7 library ID returned by resolve",
  },
  topic: { type: "string", description: "Optional documentation topic" },
  tokens: {
    type: "integer",
    default: 0,
    description:
      "Optional token budget for fetch; zero uses the backend default",
  },
} as const;

const sgraphParameters = {
  query: {
    type: "string",
    required: true,
    description: "Sourcegraph search query",
  },
  count: {
    type: "integer",
    default: 10,
    description: "Optional result count; defaults to 10",
  },
  context: {
    type: "integer",
    default: 10,
    description: "Optional context lines; defaults to 10",
  },
  timeout: {
    type: "integer",
    default: 0,
    description: "Optional timeout in seconds; zero disables the timeout",
  },
} as const;

const fetchOutput = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", required: true },
      mode: {
        type: "string",
        enum: ["full", "tree", "section"],
        required: true,
      },
      content: { type: "string", required: true },
    },
  } as const,
  render: (_args: unknown, value: FetchResult) => [
    {
      type: "text" as const,
      text: boundedToolText(
        value.content,
        "Use web_fetch with tree or section_id to navigate the document.",
      ),
    },
  ],
};

const linksOutput = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", required: true },
      links: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true },
            url: { type: "string", required: true },
          },
        },
      },
      truncated: { type: "boolean", required: true },
    },
  } as const,
  render: (_args: unknown, value: LinksResult) => [
    {
      type: "text" as const,
      text: boundedToolText(
        formatLinks(value),
        "Use web_fetch to read a selected destination.",
      ),
    },
  ],
};

const docsOutput = {
  schema: {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", required: true },
          libraries: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                title: { type: "string", required: true },
                description: { type: "string" },
                trust_score: { type: "number" },
                total_snippets: { type: "integer" },
                versions: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          library_id: { type: "string", required: true },
          topic: { type: "string" },
          content: { type: "string", required: true },
        },
      },
    ],
  } as const,
  render: (_args: unknown, value: DocsResolveResult | DocsFetchResult) => [
    {
      type: "text" as const,
      text:
        "libraries" in value
          ? boundedToolText(
              formatDocsResolve(value),
              "Use web_docs action fetch with a library_id from the results.",
            )
          : boundedToolText(
              value.content,
              "Refetch with a narrower topic or tokens budget for the remainder.",
            ),
    },
  ],
};

const sgraphOutput = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { content: { type: "string", required: true } },
  } as const,
  render: (_args: unknown, value: SGraphResult) => [
    {
      type: "text" as const,
      text: boundedToolText(
        value.content,
        "Use a narrower Sourcegraph query or lower count and context.",
      ),
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  input: unknown,
  fields: readonly string[],
  toolName: string,
): void {
  if (!isRecord(input)) return;
  for (const field of Object.keys(input))
    if (!fields.includes(field))
      throw new Error(`${toolName} input does not accept field ${field}`);
}

function strictDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    parameters: { ...definition.parameters, additionalProperties: false },
  };
}

function requireString(input: unknown, field: string): string {
  if (
    !isRecord(input) ||
    typeof input[field] !== "string" ||
    input[field].length === 0
  )
    throw new Error(`${field} must be a non-empty string`);
  return input[field];
}

function normalizeLinks(input: unknown): LinksInput {
  if (!isRecord(input)) throw new Error("web_links input must be an object");
  rejectUnknownFields(input, Object.keys(linksParameters), "web_links");
  const url = requireString(input, "url");
  const limit = input.limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_LINK_LIMIT)
  )
    throw new Error(
      `limit must be an integer from 1 through ${MAX_LINK_LIMIT}`,
    );

  const render = input.render;
  const waitMs = input.waitMs;
  if (render !== undefined && render !== "fetch" && render !== "agent-browser")
    throw new Error('render must be "fetch" or "agent-browser"');
  if (render !== "agent-browser") {
    if (waitMs !== undefined)
      throw new Error("waitMs is only valid with render agent-browser");
  } else {
    if (waitMs === undefined)
      throw new Error("waitMs is required with render agent-browser");
    if (
      typeof waitMs !== "number" ||
      !Number.isInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > 30_000
    )
      throw new Error("waitMs must be an integer from 0 through 30000");
  }

  return {
    url,
    ...(limit !== undefined ? { limit } : {}),
    ...(render !== undefined ? { render } : {}),
    ...(waitMs !== undefined ? { waitMs } : {}),
  };
}

function normalizeDocs(input: unknown): DocsToolInput {
  if (!isRecord(input)) throw new Error("web_docs input must be an object");
  return normalizeDocsToolInput(input);
}

async function context7Credentials(
  dependencies: WebToolDependencies,
): Promise<Context7Credentials> {
  let resolved: ResolvedCredential | undefined;
  try {
    resolved = await dependencies.credentials.resolve(
      credentialRef(CONTEXT7_CREDENTIAL_REF),
    );
  } catch {
    throw new Error("Context7 credential resolution failed");
  }
  return resolved === undefined ? {} : { context7ApiKey: resolved.value };
}

function boundedToolText(content: string, hint: string): string {
  const truncation = truncateHead(content);
  if (!truncation.truncated) return content;
  const guidance = hint.trim() === "" ? "" : ` ${hint.trim()}`;
  if (truncation.firstLineExceedsLimit)
    return `[First line is ${formatSize(truncation.totalBytes)}, exceeds ${formatSize(truncation.maxBytes)} limit.${guidance}]`;
  if (truncation.truncatedBy === "lines")
    return `${truncation.content}\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines} line limit).${guidance}]`;
  return `${truncation.content}\n\n[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes)} limit).${guidance}]`;
}

function formatDocsResolve(result: DocsResolveResult): string {
  if (result.libraries.length === 0)
    return `No libraries found for ${JSON.stringify(result.query)}`;
  return `Found ${result.libraries.length} libraries:\n${result.libraries.map((library) => `- ${library.id}: ${library.title}`).join("\n")}`;
}

function formatLinks(result: LinksResult): string {
  if (result.links.length === 0) return "No HTTP(S) links found.";
  const lines = result.links.map(
    (link, index) =>
      `${index + 1}. ${link.text || "(no text)"}\n   URL: ${link.url}`,
  );
  return `Found ${result.links.length} link${result.links.length === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}:\n\n${lines.join("\n\n")}`;
}

function webFetchTool(
  dependencies: WebToolDependencies,
  operations: WebOperations,
): ToolDefinition {
  return strictDefinition(
    defineTool({
      name: "web_fetch",
      description:
        "Use direct fetch for static, SSR, and pre-rendered pages. For client-rendered or SPA pages, set render: agent-browser with required waitMs on a host that has agent-browser installed; there is no automatic fallback.",
      parameters: fetchParameters,
      output: fetchOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        rejectUnknownFields(args, Object.keys(fetchParameters), "web_fetch");
        return operations.fetch(
          {
            url: requireString(args, "url"),
            tree: args.tree,
            section_id: args.section_id,
            full: args.full,
            tree_threshold: args.tree_threshold,
            render: args.render,
            waitMs: args.waitMs,
          },
          exec.signal,
        );
      },
    }),
  );
}

function webLinksTool(
  dependencies: WebToolDependencies,
  operations: WebOperations,
): ToolDefinition {
  return strictDefinition(
    defineTool({
      name: "web_links",
      description:
        "List HTTP(S) links from a page. Use direct fetch for static pages, or explicit agent-browser rendering with waitMs for client-rendered pages.",
      parameters: linksParameters,
      output: linksOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return operations.links(normalizeLinks(args), exec.signal);
      },
    }),
  );
}

function webDocsTool(
  dependencies: WebToolDependencies,
  operations: WebOperations,
): ToolDefinition {
  return strictDefinition(
    defineTool({
      name: "web_docs",
      description:
        "Resolve a library and fetch its documentation through Context7. Use action resolve with query, then action fetch with library_id.",
      parameters: docsParameters,
      output: docsOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const input = normalizeDocs(args);
        const credentials = await context7Credentials(dependencies);
        try {
          return input.action === "resolve"
            ? await operations.docsResolve({
                query: input.query,
                credentials,
                signal: exec.signal,
              })
            : await operations.docsFetch({
                ...input,
                credentials,
                signal: exec.signal,
              });
        } catch (error) {
          if (error instanceof Error && error.message === "Operation aborted")
            throw error;
          throw new Error(`web docs ${input.action} failed`);
        }
      },
    }),
  );
}

function webSgraphTool(
  dependencies: WebToolDependencies,
  operations: WebOperations,
): ToolDefinition {
  return strictDefinition(
    defineTool({
      name: "web_source_search",
      description: "Search public source code through Sourcegraph.",
      parameters: sgraphParameters,
      output: sgraphOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        rejectUnknownFields(
          args,
          Object.keys(sgraphParameters),
          "web_source_search",
        );
        return operations.sgraphSearch({
          query: requireString(args, "query"),
          count: args.count,
          context: args.context,
          timeout: args.timeout,
          signal: exec.signal,
        });
      },
    }),
  );
}

export function createWebToolDefinitions(
  dependencies: WebToolDependencies,
): readonly [ToolDefinition, ToolDefinition, ToolDefinition, ToolDefinition] {
  const operations = dependencies.operations ?? createWebOperations();
  return [
    webFetchTool(dependencies, operations),
    webLinksTool(dependencies, operations),
    webDocsTool(dependencies, operations),
    webSgraphTool(dependencies, operations),
  ];
}

export function registerWebTools(
  ctx: Context,
  dependencies: WebToolDependencies,
): void {
  for (const definition of createWebToolDefinitions(dependencies))
    ctx.tools.register(definition);
}
