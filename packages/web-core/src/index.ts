import {
  docsFetch,
  docsResolve,
  type Context7Credentials,
  type DocsFetchInput,
  type DocsFetchResult,
  type DocsResolveInput,
  type DocsResolveResult,
} from "./docs.js";
import {
  fetchWebLinks,
  fetchWebPage,
  type FetchInput,
  type FetchResult,
  type LinksInput,
  type LinksResult,
} from "./fetch.js";
import { sgraphSearch, type SGraphInput, type SGraphResult } from "./sgraph.js";
import {
  callKeposBridge,
  DEFAULT_KEPOS_BRIDGE_ENDPOINT,
  type KeposBridgeInput,
  type KeposBridgeResponse,
} from "./kepos-bridge.js";
import {
  boundedRequest,
  isOperationAborted,
  isRequestTimeout,
  readResponseText,
  throwIfAborted,
} from "./request.js";

export {
  OperationAbortedError,
  RequestTimeoutError,
  ResponseBodyLimitError,
  isOperationAborted,
  isRequestTimeout,
  isResponseBodyLimit,
} from "./request.js";

export {
  fetchWebPage,
  fetchWebLinks,
  DEFAULT_LINK_LIMIT,
  FetchCapabilityError,
  RENDER_CDN_ALLOWLIST,
  RENDER_REPORT_URL,
  MAX_LINK_LIMIT,
  type FetchCache,
  type FetchErrorDetails,
  type FetchInput,
  type FetchOptions,
  type FetchResult,
  type LinksInput,
  type LinksResult,
  type PageLink,
} from "./fetch.js";
export {
  renderMarkdown,
  truncateContent,
  type MarkdownResult,
} from "./markdown.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationOptions,
  type TruncationResult,
} from "./truncate-core.js";
export {
  formatSourcegraphResults,
  sgraphSearch,
  type SGraphInput,
  type SGraphResult,
} from "./sgraph.js";
export {
  docsFetch,
  docsResolve,
  normalizeDocsToolInput,
  normalizeLibraryID,
  type Context7Credentials,
  type DocsFetchInput,
  type DocsFetchResult,
  type DocsToolInput,
  type DocsLibrary,
  type DocsResolveInput,
  type DocsResolveResult,
} from "./docs.js";
export {
  callKeposBridge,
  DEFAULT_KEPOS_BRIDGE_ENDPOINT,
  KEPOS_BRIDGE_TIMEOUT_MS,
  KEPOS_BRIDGE_MAX_REQUEST_BYTES,
  KEPOS_BRIDGE_MAX_RESPONSE_BYTES,
  isValidKeposBridgeEndpoint,
  validateKeposBridgeEndpoint,
  type KeposBridgeCommands,
  type KeposBridgeInput,
  type KeposBridgeResponse,
} from "./kepos-bridge.js";

const EXA_BASE_URL = "https://api.exa.ai";
const BRAVE_BASE_URL = "https://api.search.brave.com/res/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 10;

export type SearchProvider = "exa" | "brave" | "kepos-bridge";
export type ProviderLabel = "Exa" | "Brave" | "Kepos Bridge";

export type SearchCredentials = {
  exaApiKey?: string;
  braveApiKey?: string;
};

export type WebCredentials = SearchCredentials & Context7Credentials;

export type SearchResult = {
  title: string;
  link: string;
  snippet: string;
  position: number;
};

export type SearchResponse = {
  provider: ProviderLabel;
  results: SearchResult[];
};

export type SearchInput = {
  query: string;
  provider?: string;
  credentials: SearchCredentials;
  maxResults?: number;
  /** Complete route used by the Kepos Bridge provider. */
  keposBridgeEndpoint?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  endpoints?: Partial<Record<SearchProvider, string>>;
  timeoutMs?: number;
};

export type WebOperations = {
  search(input: SearchInput): Promise<SearchResponse>;
  keposBridge(input: KeposBridgeInput): Promise<KeposBridgeResponse>;
  fetch(input: FetchInput, signal?: AbortSignal): Promise<FetchResult>;
  links(input: LinksInput, signal?: AbortSignal): Promise<LinksResult>;
  docsResolve(input: DocsResolveInput): Promise<DocsResolveResult>;
  docsFetch(input: DocsFetchInput): Promise<DocsFetchResult>;
  sgraphSearch(input: SGraphInput): Promise<SGraphResult>;
};

/** Creates the default in-process implementation shared by every host adapter. */
export function createWebOperations(): WebOperations {
  return {
    search,
    keposBridge: callKeposBridge,
    fetch: fetchWebPage,
    links: fetchWebLinks,
    docsResolve,
    docsFetch,
    sgraphSearch,
  };
}

/**
 * Performs one provider search using native fetch. Endpoints and fetch are
 * injectable so tests can use local fixtures without touching live services.
 */
export async function search(input: SearchInput): Promise<SearchResponse> {
  if (input.query === "") throw new Error("query is required");
  throwIfAborted(input.signal);

  const provider = selectProvider(input.provider, input.credentials);
  try {
    const result = await (provider === "exa"
      ? searchExa(input)
      : provider === "brave"
        ? searchBrave(input)
        : searchKeposBridge(input));
    throwIfAborted(input.signal);
    return result;
  } catch (error) {
    if (isOperationAborted(error) || isRequestTimeout(error)) throw error;
    const message =
      error instanceof Error ? error.message : "search request failed";
    throw new Error(
      `search failed with ${providerLabel(provider)} provider: ${message}`,
    );
  }
}

export function selectProvider(
  explicitProvider: string | undefined,
  credentials: SearchCredentials,
): SearchProvider {
  if (
    explicitProvider !== undefined &&
    explicitProvider !== "exa" &&
    explicitProvider !== "brave" &&
    explicitProvider !== "kepos-bridge"
  ) {
    throw new Error(
      `unsupported search provider ${JSON.stringify(explicitProvider)}`,
    );
  }

  if (explicitProvider === "exa") {
    if (credentials.exaApiKey === undefined || credentials.exaApiKey === "") {
      throw new Error(
        "EXA_API_KEY is required when --provider exa is selected",
      );
    }
    return "exa";
  }
  if (explicitProvider === "brave") {
    if (
      credentials.braveApiKey === undefined ||
      credentials.braveApiKey === ""
    ) {
      throw new Error(
        "BRAVE_API_KEY is required when --provider brave is selected",
      );
    }
    return "brave";
  }
  if (explicitProvider === "kepos-bridge") return "kepos-bridge";

  if (credentials.exaApiKey === "") {
    throw new Error(
      "EXA_API_KEY is set but empty; provide a valid key or unset it to use Brave",
    );
  }
  if (credentials.exaApiKey !== undefined) return "exa";
  if (credentials.braveApiKey === "") {
    throw new Error(
      "BRAVE_API_KEY is set but empty; provide a valid key or unset it",
    );
  }
  if (credentials.braveApiKey !== undefined) return "brave";
  throw new Error("web search requires EXA_API_KEY or BRAVE_API_KEY");
}

function providerLabel(provider: SearchProvider): ProviderLabel {
  return provider === "exa"
    ? "Exa"
    : provider === "brave"
      ? "Brave"
      : "Kepos Bridge";
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0)
    return "No results found. Try rephrasing your search.\n";
  let output = `Found ${results.length} search results:\n\n`;
  for (const result of results) {
    output += `${result.position}. ${result.title}\n`;
    output += `   URL: ${result.link}\n`;
    output += `   Summary: ${result.snippet}\n\n`;
  }
  return output;
}

async function searchExa(input: SearchInput): Promise<SearchResponse> {
  const endpoint = `${(input.endpoints?.exa ?? EXA_BASE_URL).replace(/\/$/, "")}/search`;
  const data = await providerRequest(
    input,
    endpoint,
    {
      method: "POST",
      headers: {
        "x-api-key": input.credentials.exaApiKey!,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        query: input.query,
        numResults: MAX_RESULTS,
        contents: { highlights: true },
      }),
    },
    "Exa",
  );
  const rawResults = asArray(data, "results", "Exa");
  return {
    provider: "Exa",
    results: rawResults.slice(0, MAX_RESULTS).map((value, index) => {
      const result = asRecord(value, "Exa");
      const highlights = Array.isArray(result.highlights)
        ? result.highlights
        : [];
      const first = highlights.find(
        (highlight): highlight is string => typeof highlight === "string",
      );
      const date =
        typeof result.publishedDate === "string" ? result.publishedDate : "";
      const author = typeof result.author === "string" ? result.author : "";
      return {
        title: stringValue(result.title),
        link: stringValue(result.url),
        snippet:
          first ??
          [date, author ? `by ${author}` : ""].filter(Boolean).join(" "),
        position: index + 1,
      };
    }),
  };
}

async function searchBrave(input: SearchInput): Promise<SearchResponse> {
  const base = (input.endpoints?.brave ?? BRAVE_BASE_URL).replace(/\/$/, "");
  const endpoint = `${base}/web/search?q=${encodeURIComponent(input.query)}&count=${MAX_RESULTS}`;
  const data = asRecord(
    await providerRequest(
      input,
      endpoint,
      {
        method: "GET",
        headers: {
          "X-Subscription-Token": input.credentials.braveApiKey!,
          accept: "application/json",
        },
      },
      "Brave",
    ),
    "Brave",
  );
  const web = asRecord(data.web, "Brave");
  const rawResults = asArray(web, "results", "Brave");
  return {
    provider: "Brave",
    results: rawResults.slice(0, MAX_RESULTS).map((value, index) => {
      const result = asRecord(value, "Brave");
      return {
        title: stringValue(result.title),
        link: stringValue(result.url),
        snippet: stringValue(result.description),
        position: index + 1,
      };
    }),
  };
}

async function searchKeposBridge(input: SearchInput): Promise<SearchResponse> {
  const endpoint =
    input.keposBridgeEndpoint ??
    input.endpoints?.["kepos-bridge"] ??
    DEFAULT_KEPOS_BRIDGE_ENDPOINT;
  const response = await callKeposBridge({
    endpoint,
    commands: { search_query: [{ q: input.query }] },
    signal: input.signal,
    fetch: input.fetch,
    timeoutMs: input.timeoutMs ?? undefined,
  });
  const usable = (response.results ?? []).filter(isUsableTextResult);
  if (usable.length === 0)
    throw new Error("Kepos Bridge search returned no usable text results");
  const limited =
    input.maxResults === undefined
      ? usable
      : usable.slice(0, normalizeMaxResults(input.maxResults));
  return {
    provider: "Kepos Bridge",
    results: limited.map((result, index) => ({
      title: typeof result.title === "string" ? result.title : "",
      link: result.url,
      snippet: typeof result.snippet === "string" ? result.snippet : "",
      position: index + 1,
    })),
  };
}

function isUsableTextResult(
  value: unknown,
): value is { url: string; title?: unknown; snippet?: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const result = value as { type?: unknown; url?: unknown };
  if (result.type !== "text_result" || typeof result.url !== "string")
    return false;
  if (result.url.length === 0) return false;
  try {
    const url = new URL(result.url);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeMaxResults(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

async function providerRequest(
  input: SearchInput,
  url: string,
  init: RequestInit,
  provider: ProviderLabel,
): Promise<unknown> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return boundedRequest(
    input.fetch,
    url,
    init,
    {
      callerSignal: input.signal,
      timeoutMs,
      timeoutMessage: `search timed out after ${timeoutMs / 1000} seconds`,
    },
    async (response, signal) => {
      if (!response.ok) {
        // Deliberately do not surface remote response bodies: they can contain
        // provider diagnostics or request data, and status is enough to act on.
        throw new Error(
          `${provider.toLowerCase()} search: HTTP ${response.status}`,
        );
      }
      try {
        return JSON.parse(
          await readResponseText(response, 1024 * 1024, signal),
        );
      } catch (error) {
        if (isOperationAborted(error) || isRequestTimeout(error)) throw error;
        throw new Error(
          `${provider.toLowerCase()} search: invalid JSON response`,
        );
      }
    },
  ).catch((error: unknown) => {
    if (isOperationAborted(error) || isRequestTimeout(error)) throw error;
    if (
      error instanceof Error &&
      error.message.startsWith(`${provider.toLowerCase()} search:`)
    )
      throw error;
    throw new Error(`${provider} search request failed`);
  });
}

function asRecord(
  value: unknown,
  provider: ProviderLabel,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${provider.toLowerCase()} search: malformed response`);
  }
  return value as Record<string, unknown>;
}

function asArray(
  value: unknown,
  key: string,
  provider: ProviderLabel,
): unknown[] {
  const record = asRecord(value, provider);
  if (!Array.isArray(record[key]))
    throw new Error(`${provider.toLowerCase()} search: malformed response`);
  return record[key];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
