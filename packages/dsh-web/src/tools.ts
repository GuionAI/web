import {
  createWebOperations,
  DEFAULT_LINK_LIMIT,
  FETCH_MODES,
  normalizeDocsToolInput,
  formatSize,
  MAX_LINK_LIMIT,
  truncateHead,
  type Context7Credentials,
  type DocsFetchResult,
  type DocsResolveResult,
  type DocsToolInput,
  type FetchInput,
  type FetchMode,
  type FetchResult,
  type LinksInput,
  type LinksResult,
  type SGraphResult,
  type KeposBridgeResponse,
  type WebOperations,
  type SearchCredentials,
  type SearchResponse,
} from "@guionai/web-core";
import {
  credentialRef,
  type CredentialRef,
  type ResolvedCredential,
} from "@deepseek-ai/dsh-credentials";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";

import {
  BRAVE_CREDENTIAL_REF,
  CONTEXT7_CREDENTIAL_REF,
  DEEPSEEK_CREDENTIAL_REF,
  EXA_CREDENTIAL_REF,
  type SearchProviderName,
} from "./contract.js";

export interface WebToolDependencies {
  credentials: {
    resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
  };
  /** Reads the current validated bridge endpoint when a Kepos tool executes. */
  getKeposBridgeEndpoint: () => string;
  /** Reads the selected provider from the live settings scope per search. */
  getProvider: () => SearchProviderName;
  operations?: WebOperations;
}

const searchParameters = {
  queries: {
    type: "array",
    required: true,
    description: "One to four web search queries",
    items: {
      type: "string",
      description: "A non-empty web search query",
    },
  },
} as const;

type SearchToolResult = SearchResponse & {
  errors?: Array<{ query: string; error: string }>;
};

const searchOutput = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      provider: { type: "string", required: true },
      results: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", required: true },
            link: { type: "string", required: true },
            snippet: { type: "string", required: true },
            position: { type: "integer", required: true },
          },
        },
      },
      errors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", required: true },
            error: { type: "string", required: true },
          },
        },
      },
    },
  } as const,
  render: (_args: unknown, value: SearchToolResult) => [
    {
      type: "text" as const,
      text: boundedToolText(
        formatSearch(value),
        "Use a narrower search query to reduce results.",
      ),
    },
  ],
};

const fetchParameters = {
  url: {
    type: "string",
    required: true,
    description: "HTTP or HTTPS URL to fetch",
  },
  mode: {
    type: "string",
    enum: [...FETCH_MODES],
    default: "auto",
    description: "Navigation mode: auto (default), full, or tree",
  },
  section_id: {
    type: "string",
    description:
      "Heading section ID; retrieves a section with omitted/auto mode",
  },
  render: {
    type: "string",
    enum: ["http", "browser"],
    description: "Page renderer; defaults to HTTP",
  },
  waitMs: {
    type: "integer",
    description: "Required post-load wait for browser rendering (0-30000)",
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
    enum: ["http", "browser"],
    description: "Page renderer; defaults to HTTP",
  },
  waitMs: {
    type: "integer",
    description: "Required post-load wait for browser rendering (0-30000)",
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

const weatherParameters = {
  location: {
    type: "string",
    required: true,
    description: 'Location in "Country, Area, City" format',
  },
  start: {
    type: "string",
    description: "Start date in YYYY-MM-DD format",
  },
  duration: {
    type: "integer",
    description: "Number of days to return",
  },
} as const;

const sportsParameters = {
  fn: {
    type: "string",
    enum: ["schedule", "standings"],
    required: true,
    description: "Sports lookup function",
  },
  league: {
    type: "string",
    enum: [
      "nba",
      "wnba",
      "nfl",
      "nhl",
      "mlb",
      "epl",
      "ncaamb",
      "ncaawb",
      "ipl",
    ],
    required: true,
    description: "League to look up",
  },
  team: { type: "string", description: "Optional team alias" },
  opponent: { type: "string", description: "Optional opposing team alias" },
  date_from: { type: "string", description: "Start date in YYYY-MM-DD format" },
  date_to: { type: "string", description: "End date in YYYY-MM-DD format" },
  num_games: { type: "integer", description: "Number of games to return" },
  locale: { type: "string", description: "Locale for the lookup" },
} as const;

const financeParameters = {
  ticker: { type: "string", required: true, description: "Ticker symbol" },
  type: {
    type: "string",
    enum: ["equity", "fund", "crypto", "index"],
    required: true,
    description: "Asset type",
  },
  market: { type: "string", description: "Optional market" },
} as const;

const timeParameters = {
  utc_offset: {
    type: "string",
    required: true,
    description: "UTC offset in +HH:MM or -HH:MM form",
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
        enum: ["auto", "full", "tree", "section"],
        required: true,
      },
      content: { type: "string", required: true },
      truncated: { type: "boolean", required: true },
    },
  } as const,
  render: (_args: unknown, value: FetchResult) => [
    {
      type: "text" as const,
      text: boundedToolText(
        value.content,
        'Use web_fetch with mode: "full" for the complete document, or section_id with the default/auto mode to navigate to a section.',
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

  const renderOptions = validateRenderOptions(input);

  return {
    url,
    ...(limit !== undefined ? { limit } : {}),
    ...renderOptions,
  };
}

function normalizeFetch(input: unknown): FetchInput {
  if (!isRecord(input)) throw new Error("web_fetch input must be an object");
  rejectUnknownFields(
    input,
    ["url", "mode", "section_id", "render", "waitMs"],
    "web_fetch",
  );
  const url = requireString(input, "url");
  const mode = input.mode;
  if (mode !== undefined && !FETCH_MODES.includes(mode as FetchMode))
    throw new Error('mode must be one of "auto", "full", or "tree"');
  const selectedMode = mode as FetchMode | undefined;
  const sectionID = input.section_id;
  if (
    sectionID !== undefined &&
    (typeof sectionID !== "string" || sectionID.trim().length === 0)
  )
    throw new Error("section_id must be a non-empty string");
  if (
    sectionID !== undefined &&
    selectedMode !== undefined &&
    selectedMode !== "auto"
  )
    throw new Error('section_id is only valid with mode "auto"');
  const renderOptions = validateRenderOptions(input);
  return {
    url,
    ...(selectedMode === undefined ? {} : { mode: selectedMode }),
    ...(sectionID === undefined ? {} : { section_id: sectionID }),
    ...renderOptions,
  };
}

function validateRenderOptions(input: {
  render?: unknown;
  waitMs?: unknown;
}): RenderOptions {
  const render = input.render;
  const waitMs = input.waitMs;
  if (render !== undefined && render !== "http" && render !== "browser")
    throw new Error('render must be "http" or "browser"');
  if (render !== "browser") {
    if (waitMs !== undefined)
      throw new Error("waitMs is only valid with render browser");
    return render === undefined ? {} : { render };
  }
  if (waitMs === undefined)
    throw new Error("waitMs is required with render browser");
  if (
    typeof waitMs !== "number" ||
    !Number.isInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > 30_000
  )
    throw new Error("waitMs must be an integer from 0 through 30000");
  return { render, waitMs };
}

type RenderOptions =
  | { render?: undefined; waitMs?: undefined }
  | { render: "http"; waitMs?: undefined }
  | { render: "browser"; waitMs: number };

function normalizeDocs(input: unknown): DocsToolInput {
  if (!isRecord(input)) throw new Error("web_docs input must be an object");
  return normalizeDocsToolInput(input);
}

function requireSearchQueries(input: unknown): string[] {
  if (!isRecord(input))
    throw new Error("queries must be an array of 1 to 4 non-empty strings");
  rejectUnknownFields(input, ["queries"], "web_search");
  if (!Array.isArray(input.queries))
    throw new Error("queries must be an array of 1 to 4 non-empty strings");
  if (input.queries.length < 1 || input.queries.length > 4)
    throw new Error("queries must be an array of 1 to 4 non-empty strings");

  const queries: string[] = [];
  for (const value of input.queries) {
    if (typeof value !== "string" || value.trim().length === 0)
      throw new Error("queries must be an array of 1 to 4 non-empty strings");
    const query = value.trim();
    if (!queries.includes(query)) queries.push(query);
  }
  if (queries.length < 1 || queries.length > 4)
    throw new Error("queries must be an array of 1 to 4 non-empty strings");
  return queries;
}

function searchCredential(
  provider: SearchProviderName,
): { ref: CredentialRef; field: keyof SearchCredentials } | undefined {
  switch (provider) {
    case "exa":
      return {
        ref: credentialRef(EXA_CREDENTIAL_REF),
        field: "exaApiKey",
      };
    case "brave":
      return {
        ref: credentialRef(BRAVE_CREDENTIAL_REF),
        field: "braveApiKey",
      };
    case "deepseek":
      return {
        ref: credentialRef(DEEPSEEK_CREDENTIAL_REF),
        field: "deepseekApiKey",
      };
    case "kepos-bridge":
      return undefined;
  }
}

function searchCredentials(
  field: keyof SearchCredentials,
  value: string,
): SearchCredentials {
  switch (field) {
    case "exaApiKey":
      return { exaApiKey: value };
    case "braveApiKey":
      return { braveApiKey: value };
    case "deepseekApiKey":
      return { deepseekApiKey: value };
  }
}

function errorMessage(reason: unknown, secret?: string): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return secret !== undefined && message.includes(secret)
    ? "search request failed"
    : message || "web search failed";
}

async function executeSearchQuery(
  query: string,
  signal: AbortSignal | undefined,
  dependencies: WebToolDependencies,
  operations: WebOperations,
): Promise<SearchResponse> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const provider = dependencies.getProvider();
  const credential = searchCredential(provider);
  let resolved: ResolvedCredential | undefined;
  if (credential !== undefined) {
    try {
      resolved = await dependencies.credentials.resolve(credential.ref);
    } catch {
      throw new Error(`${provider} credential resolution failed`);
    }
  }
  if (signal?.aborted) throw new Error("Operation aborted");
  const credentials =
    credential === undefined || resolved === undefined
      ? {}
      : searchCredentials(credential.field, resolved.value);
  const input = {
    query,
    provider,
    credentials,
    signal,
    ...(provider === "kepos-bridge"
      ? { keposBridgeEndpoint: dependencies.getKeposBridgeEndpoint() }
      : {}),
  };
  try {
    return await operations.search(input);
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.message === "Operation aborted")
    )
      throw new Error("Operation aborted");
    throw new Error(errorMessage(error, resolved?.value));
  }
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

function formatSearch(value: SearchToolResult): string {
  const lines = value.results.map(
    (result) =>
      `${result.position}. ${result.title}\n   URL: ${result.link}\n   ${result.snippet}`,
  );
  const failures =
    value.errors === undefined || value.errors.length === 0
      ? ""
      : `\n\nSearch failures:\n${value.errors.map((failure) => `- ${JSON.stringify(failure.query)}: ${failure.error}`).join("\n")}`;
  if (lines.length === 0) return `No search results.${failures}`;
  return `Found ${lines.length} search results (provider: ${value.provider}):\n\n${lines.join("\n\n")}${failures}`;
}

function webSearchTool(
  dependencies: WebToolDependencies,
  operations: WebOperations,
): ToolDefinition {
  return strictDefinition(
    defineTool({
      name: "web_search",
      description:
        "Search the web for current facts. Provide one to four queries; repeated queries are merged and model-facing text is bounded.",
      parameters: searchParameters,
      output: searchOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const queries = requireSearchQueries(args);
        const settled = await Promise.allSettled(
          queries.map((query) =>
            executeSearchQuery(query, exec.signal, dependencies, operations),
          ),
        );
        if (exec.signal.aborted) throw new Error("Operation aborted");

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
        if (responses.length === 0) {
          throw new Error(
            `web search failed for all queries:\n${errors
              .map(
                (failure) =>
                  `- ${JSON.stringify(failure.query)}: ${failure.error}`,
              )
              .join("\n")}`,
          );
        }
        const merged = mergeSearchResults(responses);
        return {
          ...merged,
          ...(errors.length > 0 ? { errors } : {}),
        } satisfies SearchToolResult;
      },
    }),
  );
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
        "Use HTTP rendering for static, SSR, and pre-rendered pages. mode selects auto, full, or tree navigation; section_id with omitted/auto mode retrieves a section. For client-rendered or SPA pages, set render: browser with required waitMs when the host provides browser capability; there is no automatic fallback.",
      parameters: fetchParameters,
      output: fetchOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return operations.fetch(normalizeFetch(args), exec.signal);
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
        "List HTTP(S) links from a page. Use HTTP rendering for static pages, or explicit browser rendering with waitMs for client-rendered pages.",
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

const keposBridgeOutput = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      output: { type: "string", required: true },
      results: { type: "array" },
    },
  } as const,
  render: (_args: unknown, value: KeposBridgeResponse) => [
    { type: "text" as const, text: value.output },
  ],
};

function normalizeDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`${field} must use YYYY-MM-DD format`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${field} must be a non-blank string`);
  return value;
}

function requireKeposString(input: unknown, field: string): string {
  if (
    !isRecord(input) ||
    typeof input[field] !== "string" ||
    input[field].trim().length === 0
  )
    throw new Error(`${field} must be a non-blank string`);
  return input[field];
}

function positiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new Error(`${field} must be one of ${values.join(", ")}`);
  return value as T;
}

function normalizeWeather(input: unknown): {
  location: string;
  start?: string;
  duration?: number;
} {
  if (!isRecord(input)) throw new Error("web_weather input must be an object");
  rejectUnknownFields(input, Object.keys(weatherParameters), "web_weather");
  const location = requireKeposString(input, "location");
  const start = normalizeDate(input.start, "start");
  const duration = positiveInteger(input.duration, "duration");
  return {
    location,
    ...(start === undefined ? {} : { start }),
    ...(duration === undefined ? {} : { duration }),
  };
}

function normalizeSports(input: unknown): {
  fn: "schedule" | "standings";
  league:
    | "nba"
    | "wnba"
    | "nfl"
    | "nhl"
    | "mlb"
    | "epl"
    | "ncaamb"
    | "ncaawb"
    | "ipl";
  team?: string;
  opponent?: string;
  date_from?: string;
  date_to?: string;
  num_games?: number;
  locale?: string;
} {
  if (!isRecord(input)) throw new Error("web_sports input must be an object");
  rejectUnknownFields(input, Object.keys(sportsParameters), "web_sports");
  const fn = enumValue(input.fn, "fn", ["schedule", "standings"] as const);
  const league = enumValue(input.league, "league", [
    "nba",
    "wnba",
    "nfl",
    "nhl",
    "mlb",
    "epl",
    "ncaamb",
    "ncaawb",
    "ipl",
  ] as const);
  const team = optionalString(input.team, "team");
  const opponent = optionalString(input.opponent, "opponent");
  const dateFrom = normalizeDate(input.date_from, "date_from");
  const dateTo = normalizeDate(input.date_to, "date_to");
  const numGames = positiveInteger(input.num_games, "num_games");
  const locale = optionalString(input.locale, "locale");
  return {
    fn,
    league,
    ...(team === undefined ? {} : { team }),
    ...(opponent === undefined ? {} : { opponent }),
    ...(dateFrom === undefined ? {} : { date_from: dateFrom }),
    ...(dateTo === undefined ? {} : { date_to: dateTo }),
    ...(numGames === undefined ? {} : { num_games: numGames }),
    ...(locale === undefined ? {} : { locale }),
  };
}

function normalizeFinance(input: unknown): {
  ticker: string;
  type: "equity" | "fund" | "crypto" | "index";
  market?: string;
} {
  if (!isRecord(input)) throw new Error("web_finance input must be an object");
  rejectUnknownFields(input, Object.keys(financeParameters), "web_finance");
  const ticker = requireKeposString(input, "ticker");
  const type = enumValue(input.type, "type", [
    "equity",
    "fund",
    "crypto",
    "index",
  ] as const);
  const market = optionalString(input.market, "market");
  return { ticker, type, ...(market === undefined ? {} : { market }) };
}

function normalizeTime(input: unknown): { utc_offset: string } {
  if (!isRecord(input)) throw new Error("web_time input must be an object");
  rejectUnknownFields(input, Object.keys(timeParameters), "web_time");
  const utcOffset = requireKeposString(input, "utc_offset");
  if (!/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(utcOffset))
    throw new Error("utc_offset must use +HH:MM or -HH:MM format");
  return { utc_offset: utcOffset };
}

function validKeposBridgeResponse(
  value: unknown,
): value is KeposBridgeResponse {
  return (
    isRecord(value) &&
    typeof value.output === "string" &&
    (value.results === undefined || Array.isArray(value.results))
  );
}

async function executeKeposTool(
  name: string,
  operation: string,
  args: unknown,
  exec: { signal?: AbortSignal },
  dependencies: WebToolDependencies,
  operations: WebOperations,
  normalize: (input: unknown) => Record<string, unknown>,
): Promise<any> {
  const normalized = normalize(args);
  try {
    const response = await operations.keposBridge({
      endpoint: dependencies.getKeposBridgeEndpoint(),
      commands: { [operation]: [normalized] },
      signal: exec.signal,
    });
    if (!validKeposBridgeResponse(response))
      throw new Error("malformed response");
    return {
      output: response.output,
      ...(response.results === undefined ? {} : { results: response.results }),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "Operation aborted" ||
        error.name === "OperationAbortedError" ||
        error.name === "RequestTimeoutError")
    )
      throw error;
    throw new Error(`${name} failed`);
  }
}

function webWeatherTool(
  dependencies: WebToolDependencies,
  operations: WebOperations,
): ToolDefinition {
  return strictDefinition(
    defineTool({
      name: "web_weather",
      description:
        "Look up a weather forecast for a Country, Area, City location.",
      parameters: weatherParameters,
      output: keposBridgeOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return executeKeposTool(
          "web_weather",
          "weather",
          args,
          exec,
          dependencies,
          operations,
          normalizeWeather as (input: unknown) => Record<string, unknown>,
        );
      },
    }),
  );
}

function webSportsTool(
  dependencies: WebToolDependencies,
  operations: WebOperations,
): ToolDefinition {
  return strictDefinition(
    defineTool({
      name: "web_sports",
      description: "Look up sports schedules or standings.",
      parameters: sportsParameters,
      output: keposBridgeOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return executeKeposTool(
          "web_sports",
          "sports",
          args,
          exec,
          dependencies,
          operations,
          normalizeSports as (input: unknown) => Record<string, unknown>,
        );
      },
    }),
  );
}

function webFinanceTool(
  dependencies: WebToolDependencies,
  operations: WebOperations,
): ToolDefinition {
  return strictDefinition(
    defineTool({
      name: "web_finance",
      description: "Look up a finance quote or index value.",
      parameters: financeParameters,
      output: keposBridgeOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return executeKeposTool(
          "web_finance",
          "finance",
          args,
          exec,
          dependencies,
          operations,
          normalizeFinance as (input: unknown) => Record<string, unknown>,
        );
      },
    }),
  );
}

function webTimeTool(
  dependencies: WebToolDependencies,
  operations: WebOperations,
): ToolDefinition {
  return strictDefinition(
    defineTool({
      name: "web_time",
      description: "Get the current time at a fixed UTC offset.",
      parameters: timeParameters,
      output: keposBridgeOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return executeKeposTool(
          "web_time",
          "time",
          args,
          exec,
          dependencies,
          operations,
          normalizeTime as (input: unknown) => Record<string, unknown>,
        );
      },
    }),
  );
}

export function createWebToolDefinitions(
  dependencies: WebToolDependencies,
): readonly [
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
] {
  const operations = dependencies.operations ?? createWebOperations();
  return [
    webSearchTool(dependencies, operations),
    webFetchTool(dependencies, operations),
    webLinksTool(dependencies, operations),
    webDocsTool(dependencies, operations),
    webSgraphTool(dependencies, operations),
  ];
}

export function createKeposToolDefinitions(
  dependencies: WebToolDependencies,
): readonly [ToolDefinition, ToolDefinition, ToolDefinition, ToolDefinition] {
  const operations = dependencies.operations ?? createWebOperations();
  return [
    webWeatherTool(dependencies, operations),
    webSportsTool(dependencies, operations),
    webFinanceTool(dependencies, operations),
    webTimeTool(dependencies, operations),
  ];
}

export function registerWebTools(
  ctx: Context,
  dependencies: WebToolDependencies,
): Array<() => void> {
  const disposers: Array<() => void> = [];
  for (const definition of createWebToolDefinitions(dependencies)) {
    const dispose = ctx.tools.register(definition);
    disposers.push(dispose);
  }
  return disposers;
}

export function registerKeposTools(
  ctx: Context,
  dependencies: WebToolDependencies,
): Array<() => void> {
  const disposers: Array<() => void> = [];
  for (const definition of createKeposToolDefinitions(dependencies)) {
    const dispose = ctx.tools.register(definition);
    disposers.push(dispose);
  }
  return disposers;
}
