import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createWebOperations,
  DEFAULT_LINK_LIMIT,
  MAX_LINK_LIMIT,
  normalizeDocsToolInput,
  type DocsToolInput,
  type LinksResult,
  type SearchProvider,
  type WebCredentials,
  type WebOperations,
  type SearchResponse,
} from "@guionai/web-core";
import { Type, type Static, type TSchema } from "typebox";

import { modelTextResult } from "./model-text.js";

const DEFAULT_TREE_THRESHOLD = 5000;

export const webSearchSchema = Type.Object(
  {
    queries: Type.Array(
      Type.String({
        description: "Web search query",
        minLength: 1,
        pattern: "\\S",
      }),
      {
        description: "One to four web search queries",
        minItems: 1,
        maxItems: 4,
      },
    ),
  },
  { additionalProperties: false },
);

const fetchNavigationProperties = {
  url: Type.String({ description: "HTTP or HTTPS URL to fetch" }),
  tree: Type.Optional(
    Type.Boolean({ description: "Show the page heading tree" }),
  ),
  section_id: Type.Optional(
    Type.String({ description: "Optional heading section ID to return" }),
  ),
  full: Type.Optional(
    Type.Boolean({
      description: "Return full content without automatic tree mode",
    }),
  ),
  tree_threshold: Type.Optional(
    Type.Integer({
      description: `Automatic tree threshold; defaults to ${DEFAULT_TREE_THRESHOLD}`,
      default: DEFAULT_TREE_THRESHOLD,
    }),
  ),
};

export const webFetchSchema = Type.Union([
  Type.Object(
    {
      ...fetchNavigationProperties,
      render: Type.Optional(
        StringEnum(["fetch"] as const, {
          description: "Use direct HTTP fetching (the default)",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...fetchNavigationProperties,
      render: StringEnum(["agent-browser"] as const, {
        description: "Render the page through the host-installed agent-browser",
      }),
      waitMs: Type.Integer({
        description: "Additional post-load wait in milliseconds",
        minimum: 0,
        maximum: 30_000,
      }),
    },
    { additionalProperties: false },
  ),
]);

const linksProperties = {
  url: Type.String({ description: "HTTP or HTTPS URL to inspect" }),
  limit: Type.Optional(
    Type.Integer({
      description: `Maximum links to return (1-${MAX_LINK_LIMIT})`,
      minimum: 1,
      maximum: MAX_LINK_LIMIT,
      default: DEFAULT_LINK_LIMIT,
    }),
  ),
};

export const webLinksSchema = Type.Union([
  Type.Object(
    {
      ...linksProperties,
      render: Type.Optional(
        StringEnum(["fetch"] as const, {
          description: "Use direct HTTP fetching (the default)",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...linksProperties,
      render: StringEnum(["agent-browser"] as const, {
        description: "Render the page through the host-installed agent-browser",
      }),
      waitMs: Type.Integer({
        description: "Additional post-load wait in milliseconds",
        minimum: 0,
        maximum: 30_000,
      }),
    },
    { additionalProperties: false },
  ),
]);

export const webDocsSchema = Type.Object(
  {
    action: StringEnum(["resolve", "fetch"] as const, {
      description: "Documentation operation",
    }),
    query: Type.Optional(
      Type.String({ description: "Library name or package query" }),
    ),
    library_id: Type.Optional(
      Type.String({ description: "Context7 library ID returned by resolve" }),
    ),
    topic: Type.Optional(
      Type.String({ description: "Optional documentation topic" }),
    ),
    tokens: Type.Optional(
      Type.Integer({
        description:
          "Optional token budget for fetch; zero uses the backend default",
        default: 0,
      }),
    ),
  },
  { additionalProperties: false },
);

export const webSgraphSchema = Type.Object(
  {
    query: Type.String({ description: "Sourcegraph search query" }),
    count: Type.Optional(
      Type.Integer({
        description: "Optional result count; defaults to 10",
        default: 10,
      }),
    ),
    context: Type.Optional(
      Type.Integer({
        description: "Optional context lines; defaults to 10",
        default: 10,
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        description: "Optional timeout in seconds; zero disables the timeout",
        default: 0,
      }),
    ),
  },
  { additionalProperties: false },
);

export type WebSearchInput = Static<typeof webSearchSchema>;
export type WebFetchInput = Static<typeof webFetchSchema>;
export type WebLinksInput = Static<typeof webLinksSchema>;
export type WebDocsInput = Static<typeof webDocsSchema>;
export type WebSgraphInput = Static<typeof webSgraphSchema>;

type SearchResult = SearchResponse & {
  errors?: Array<{ query: string; error: string }>;
};

export type WebToolDependencies = {
  operations?: WebOperations;
  credentials?: () => WebCredentials;
  /** Pins the provider used by every Pi web search. */
  provider?: SearchProvider;
};

const SEARCH_PROMPT_GUIDELINES = [
  "Use web_search to search the web for current facts.",
];
const FETCH_PROMPT_GUIDELINES = [
  "Use web_fetch to read a web page; large pages are truncated with a continuation notice, so follow up with tree or section_id to navigate.",
  'web_fetch has two backends: omit render or use render: "fetch" for direct HTML-to-Markdown (the default for static, SSR, and pre-rendered pages).',
  'For a client-rendered or SPA page, or after javascript_rendering_may_be_required, retry explicitly with render: "agent-browser" and waitMs: 2000 only when the host has agent-browser installed. Increase waitMs explicitly or abandon an incomplete page; there is no automatic fallback.',
  "Never send waitMs with direct fetch. agent-browser is a host capability, not a package dependency.",
];
const LINKS_PROMPT_GUIDELINES = [
  "Use web_links to discover HTTP(S) destinations from a page, including navigation and links outside the readable article body.",
  'Use direct fetch by default. For a client-rendered or SPA page, explicitly use render: "agent-browser" with waitMs; there is no automatic fallback.',
  "Never send waitMs with direct fetch. agent-browser is a host capability, not a package dependency.",
];
const DOCS_PROMPT_GUIDELINES = [
  "Use web_docs with action resolve, then action fetch, to read library documentation instead of fetching documentation sites page by page.",
  "For web_docs action fetch, provide the library_id returned by action resolve; use topic or tokens to narrow the result.",
];
const SGRAPH_PROMPT_GUIDELINES = [
  "Use web_source_search to search public source code through Sourcegraph.",
];

function environmentCredentials(): WebCredentials {
  return {
    exaApiKey: process.env.EXA_API_KEY,
    braveApiKey: process.env.BRAVE_API_KEY,
    ...(Object.hasOwn(process.env, "CONTEXT7_API_KEY")
      ? { context7ApiKey: process.env.CONTEXT7_API_KEY }
      : {}),
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function requireString(input: unknown, field: string): string {
  if (
    !isRecord(input) ||
    typeof input[field] !== "string" ||
    input[field].length === 0
  ) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return input[field];
}

function requireQueries(input: unknown): string[] {
  if (!isRecord(input))
    throw new Error("queries must be an array of 1 to 4 non-empty strings");
  for (const field of Object.keys(input)) {
    if (field !== "queries")
      throw new Error(`web_search input does not accept field ${field}`);
  }
  if (
    !Array.isArray(input.queries) ||
    input.queries.length < 1 ||
    input.queries.length > 4 ||
    input.queries.some(
      (query) => typeof query !== "string" || query.trim().length === 0,
    )
  ) {
    throw new Error("queries must be an array of 1 to 4 non-empty strings");
  }
  return [...new Set(input.queries)];
}

function normalizeFetch(input: unknown): WebFetchInput {
  if (!isRecord(input)) throw new Error("web_fetch input must be an object");
  const url = requireString(input, "url");
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
  const typed = input as unknown as WebFetchInput;
  const navigation = {
    url,
    tree: typed.tree,
    section_id: typed.section_id,
    full: typed.full,
    tree_threshold: typed.tree_threshold,
  };
  if (render === "agent-browser")
    return { ...navigation, render, waitMs: waitMs as number };
  if (render === "fetch") return { ...navigation, render };
  return navigation;
}

function normalizeLinks(input: unknown): WebLinksInput {
  if (!isRecord(input)) throw new Error("web_links input must be an object");
  const url = requireString(input, "url");
  const render = input.render;
  const waitMs = input.waitMs;
  const limit = input.limit;
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
  const typed = input as unknown as WebLinksInput;
  const result = { url, limit: typed.limit };
  if (render === "agent-browser")
    return { ...result, render, waitMs: waitMs as number };
  if (render === "fetch") return { ...result, render };
  return result;
}

function mergeSearchResults(responses: SearchResponse[]): SearchResponse {
  const results: SearchResponse["results"] = [];
  for (let resultIndex = 0; ; resultIndex += 1) {
    let added = false;
    for (const response of responses) {
      const result = response.results[resultIndex];
      if (result === undefined) continue;
      results.push({ ...result, position: results.length + 1 });
      added = true;
    }
    if (!added) return { provider: responses[0]?.provider ?? "", results };
  }
}

function normalizeDocs(input: unknown): DocsToolInput {
  if (!isRecord(input)) throw new Error("web_docs input must be an object");
  return normalizeDocsToolInput(input);
}

export function webSearchTool(dependencies: WebToolDependencies = {}) {
  const operations = dependencies.operations ?? createWebOperations();
  const credentials = dependencies.credentials ?? environmentCredentials;
  const provider = dependencies.provider ?? process.env.WEB_SEARCH_PROVIDER;
  return makeTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web for current facts. Provide one to four queries; text output is limited to 2,000 lines or 50KB.",
    promptSnippet: "Search the web with web_search",
    promptGuidelines: SEARCH_PROMPT_GUIDELINES,
    parameters: webSearchSchema,
    execute: async (params, signal) => {
      const queries = requireQueries(params);
      const settled = await Promise.allSettled(
        queries.map((query) =>
          operations.search({
            query,
            ...(provider === undefined ? {} : { provider }),
            credentials: credentials(),
            signal,
          }),
        ),
      );
      if (signal?.aborted) throw new Error("Operation aborted");
      const responses: SearchResponse[] = [];
      const errors: Array<{ query: string; error: string }> = [];
      for (const [index, result] of settled.entries()) {
        if (result.status === "fulfilled") responses.push(result.value);
        else
          errors.push({
            query: queries[index]!,
            error: errorMessage(result.reason),
          });
      }
      if (responses.length === 0)
        throw new Error(errors[0]?.error ?? "web search failed");
      const data: SearchResult = {
        ...mergeSearchResults(responses),
        ...(errors.length > 0 ? { errors } : {}),
      };
      const lines = data.results.map(
        (result) =>
          `${result.position}. ${result.title}\n   URL: ${result.link}\n   ${result.snippet}`,
      );
      const failures =
        errors.length === 0
          ? ""
          : `\n\nSearch failures:\n${errors.map((failure) => `- ${JSON.stringify(failure.query)}: ${failure.error}`).join("\n")}`;
      const text =
        lines.length === 0
          ? `No search results.${failures}`
          : `Found ${lines.length} search results (provider: ${data.provider}):\n\n${lines.join("\n\n")}${failures}`;
      return modelTextResult(data, text, {
        hint: "Use a narrower search query to reduce results.",
      });
    },
  });
}

export function webFetchTool(dependencies: WebToolDependencies = {}) {
  const operations = dependencies.operations ?? createWebOperations();
  return makeTool({
    name: "web_fetch",
    label: "Web fetch",
    description:
      "Fetch and read an HTTP or HTTPS web page as Markdown, with direct fetch or explicit agent-browser rendering for client-rendered pages. Rendered fetch requires waitMs 0 through 30000. Text output is limited to 2,000 lines or 50KB; truncated output is saved to a temporary file.",
    promptSnippet: "Fetch a web page with web_fetch",
    promptGuidelines: FETCH_PROMPT_GUIDELINES,
    parameters: webFetchSchema,
    execute: async (params, signal) => {
      const data = await operations.fetch(normalizeFetch(params), signal);
      return modelTextResult(data, data.content, {
        hint: "Use web_fetch with tree or section_id to navigate the document.",
      });
    },
  });
}

export function webLinksTool(dependencies: WebToolDependencies = {}) {
  const operations = dependencies.operations ?? createWebOperations();
  return makeTool({
    name: "web_links",
    label: "Web links",
    description:
      "List HTTP(S) links from a web page, with direct fetch or explicit agent-browser rendering for client-rendered pages.",
    promptSnippet: "List links from a web page with web_links",
    promptGuidelines: LINKS_PROMPT_GUIDELINES,
    parameters: webLinksSchema,
    execute: async (params, signal) => {
      const data = await operations.links(normalizeLinks(params), signal);
      return modelTextResult(data, formatLinks(data), {
        hint: "Use web_fetch to read a selected destination.",
      });
    },
  });
}

export function webDocsTool(dependencies: WebToolDependencies = {}) {
  const operations = dependencies.operations ?? createWebOperations();
  const credentials = dependencies.credentials ?? environmentCredentials;
  return makeTool({
    name: "web_docs",
    label: "Web docs",
    description:
      "Resolve a library and fetch its documentation through Context7. Use action resolve with query, then action fetch with library_id; text output is limited to 2,000 lines or 50KB.",
    promptSnippet: "Resolve or fetch library documentation with web_docs",
    promptGuidelines: DOCS_PROMPT_GUIDELINES,
    parameters: webDocsSchema,
    execute: async (params, signal) => {
      const input = normalizeDocs(params);
      if (input.action === "resolve") {
        const data = await operations.docsResolve({
          query: input.query,
          credentials: credentials(),
          signal,
        });
        const lines = data.libraries.map(
          (library) => `- ${library.id}: ${library.title}`,
        );
        const text =
          lines.length === 0
            ? `No libraries found for ${JSON.stringify(input.query)}`
            : `Found ${lines.length} libraries:\n${lines.join("\n")}`;
        return modelTextResult(data, text, {
          hint: "Use web_docs action fetch with a library_id from the results.",
        });
      }
      const data = await operations.docsFetch({
        ...input,
        credentials: credentials(),
        signal,
      });
      return modelTextResult(data, data.content, {
        hint: "Refetch with a narrower topic or tokens budget for the remainder.",
      });
    },
  });
}

export function webSgraphTool(dependencies: WebToolDependencies = {}) {
  const operations = dependencies.operations ?? createWebOperations();
  return makeTool({
    name: "web_source_search",
    label: "Web source search",
    description:
      "Search public source code through Sourcegraph. Text output is limited to 2,000 lines or 50KB; truncated output is saved to a temporary file.",
    promptSnippet: "Search public source code with web_source_search",
    promptGuidelines: SGRAPH_PROMPT_GUIDELINES,
    parameters: webSgraphSchema,
    execute: async (params, signal) => {
      const input = params as WebSgraphInput;
      const data = await operations.sgraphSearch({
        query: requireString(params, "query"),
        count: input.count,
        context: input.context,
        timeout: input.timeout,
        signal,
      });
      return modelTextResult(data, data.content, {
        hint: "Use a narrower Sourcegraph query or lower count and context.",
      });
    },
  });
}

function makeTool(options: {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: TSchema;
  execute(
    params: unknown,
    signal?: AbortSignal,
  ): ReturnType<typeof modelTextResult>;
}) {
  return {
    name: options.name,
    label: options.label,
    description: options.description,
    promptSnippet: options.promptSnippet,
    promptGuidelines: options.promptGuidelines,
    parameters: options.parameters,
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      return options.execute(params, signal);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "web search failed";
}

function formatLinks(result: LinksResult): string {
  if (result.links.length === 0) return "No HTTP(S) links found.";
  const lines = result.links.map(
    (link, index) =>
      `${index + 1}. ${link.text || "(no text)"}\n   URL: ${link.url}`,
  );
  return `Found ${result.links.length} link${result.links.length === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}:\n\n${lines.join("\n\n")}`;
}

export function registerWebTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  dependencies: WebToolDependencies = {},
): void {
  const shared = {
    ...dependencies,
    operations: dependencies.operations ?? createWebOperations(),
  };
  pi.registerTool(webSearchTool(shared));
  pi.registerTool(webFetchTool(shared));
  pi.registerTool(webLinksTool(shared));
  pi.registerTool(webDocsTool(shared));
  pi.registerTool(webSgraphTool(shared));
}
