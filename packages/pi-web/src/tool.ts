import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  docsFetch,
  docsResolve,
  fetchWebPage,
  search,
  sgraphSearch,
  type Context7Credentials,
  type DocsFetchInput,
  type DocsFetchResult,
  type DocsResolveInput,
  type DocsResolveResult,
  type FetchInput,
  type FetchResult,
  type SearchCredentials,
  type SearchInput,
  type SearchResponse,
  type SGraphInput,
  type SGraphResult,
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

export const webFetchSchema = Type.Object(
  {
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
  },
  { additionalProperties: false },
);

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
export type WebDocsInput = Static<typeof webDocsSchema>;
export type WebSgraphInput = Static<typeof webSgraphSchema>;

type DocsInput =
  | { action: "resolve"; query: string }
  | { action: "fetch"; library_id: string; topic?: string; tokens?: number };

type WebCredentials = SearchCredentials & Context7Credentials;
type SearchResult = SearchResponse & {
  errors?: Array<{ query: string; error: string }>;
};

export type WebToolDependencies = {
  search?: (input: SearchInput) => Promise<SearchResponse>;
  fetch?: (input: FetchInput, signal?: AbortSignal) => Promise<FetchResult>;
  docsResolve?: (input: DocsResolveInput) => Promise<DocsResolveResult>;
  docsFetch?: (input: DocsFetchInput) => Promise<DocsFetchResult>;
  sgraphSearch?: (input: SGraphInput) => Promise<SGraphResult>;
  credentials?: () => WebCredentials;
};

const SEARCH_PROMPT_GUIDELINES = [
  "Use web_search to search the web for current facts.",
];
const FETCH_PROMPT_GUIDELINES = [
  "Use web_fetch to read a web page; large pages are truncated with a continuation notice, so follow up with tree or section_id to navigate.",
];
const DOCS_PROMPT_GUIDELINES = [
  "Use web_docs with action resolve, then action fetch, to read library documentation instead of fetching documentation sites page by page.",
  "For web_docs action fetch, provide the library_id returned by action resolve; use topic or tokens to narrow the result.",
];
const SGRAPH_PROMPT_GUIDELINES = [
  "Use web_sgraph to search public source code through Sourcegraph.",
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

function normalizeDocs(input: unknown): DocsInput {
  if (!isRecord(input)) throw new Error("web_docs input must be an object");
  for (const field of Object.keys(input)) {
    if (!["action", "query", "library_id", "topic", "tokens"].includes(field)) {
      throw new Error(`web_docs input does not accept field ${field}`);
    }
  }
  if (input.action !== "resolve" && input.action !== "fetch") {
    throw new Error('web_docs action must be "resolve" or "fetch"');
  }
  if (input.action === "resolve") {
    if ("library_id" in input || "topic" in input || "tokens" in input) {
      throw new Error(
        'web_docs action "resolve" does not accept library_id, topic, or tokens',
      );
    }
    return { action: "resolve", query: requireString(input, "query") };
  }
  if ("query" in input)
    throw new Error('web_docs action "fetch" does not accept query');
  const library_id = requireString(input, "library_id");
  if (input.topic !== undefined && typeof input.topic !== "string")
    throw new Error("topic must be a string");
  if (
    input.tokens !== undefined &&
    (!Number.isInteger(input.tokens) || typeof input.tokens !== "number")
  ) {
    throw new Error("tokens must be an integer");
  }
  return {
    action: "fetch",
    library_id,
    topic: input.topic as string | undefined,
    tokens: input.tokens as number | undefined,
  };
}

export function webSearchTool(dependencies: WebToolDependencies = {}) {
  const searchOperation = dependencies.search ?? search;
  const credentials = dependencies.credentials ?? environmentCredentials;
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
          searchOperation({
            query,
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
  const fetchOperation = dependencies.fetch ?? fetchWebPage;
  return makeTool({
    name: "web_fetch",
    label: "Web fetch",
    description:
      "Fetch and read an HTTP or HTTPS web page as Markdown, with heading-tree navigation. Text output is limited to 2,000 lines or 50KB; truncated output is saved to a temporary file.",
    promptSnippet: "Fetch a web page with web_fetch",
    promptGuidelines: FETCH_PROMPT_GUIDELINES,
    parameters: webFetchSchema,
    execute: async (params, signal) => {
      const data = await fetchOperation(
        {
          url: requireString(params, "url"),
          tree: (params as WebFetchInput).tree,
          section_id: (params as WebFetchInput).section_id,
          full: (params as WebFetchInput).full,
          tree_threshold: (params as WebFetchInput).tree_threshold,
        },
        signal,
      );
      return modelTextResult(data, data.content, {
        hint: "Use web_fetch with tree or section_id to navigate the document.",
      });
    },
  });
}

export function webDocsTool(dependencies: WebToolDependencies = {}) {
  const resolve = dependencies.docsResolve ?? docsResolve;
  const fetch = dependencies.docsFetch ?? docsFetch;
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
        const data = await resolve({
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
      const data = await fetch({
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
  const operation = dependencies.sgraphSearch ?? sgraphSearch;
  return makeTool({
    name: "web_sgraph",
    label: "Web source search",
    description:
      "Search public source code through Sourcegraph. Text output is limited to 2,000 lines or 50KB; truncated output is saved to a temporary file.",
    promptSnippet: "Search public source code with web_sgraph",
    promptGuidelines: SGRAPH_PROMPT_GUIDELINES,
    parameters: webSgraphSchema,
    execute: async (params, signal) => {
      const input = params as WebSgraphInput;
      const data = await operation({
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

export function registerWebTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  dependencies: WebToolDependencies = {},
): void {
  pi.registerTool(webSearchTool(dependencies));
  pi.registerTool(webFetchTool(dependencies));
  pi.registerTool(webDocsTool(dependencies));
  pi.registerTool(webSgraphTool(dependencies));
}
