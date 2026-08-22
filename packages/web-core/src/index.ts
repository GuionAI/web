export { fetchWebPage, type FetchCache, type FetchInput, type FetchOptions, type FetchResult } from "./fetch.js";
export { renderMarkdown, truncateContent, type MarkdownResult } from "./markdown.js";

const EXA_BASE_URL = "https://api.exa.ai";
const BRAVE_BASE_URL = "https://api.search.brave.com/res/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESULTS = 10;

export type SearchProvider = "exa" | "brave";
export type ProviderLabel = "Exa" | "Brave";

export type SearchCredentials = {
  exaApiKey?: string;
  braveApiKey?: string;
};

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
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  endpoints?: Partial<Record<SearchProvider, string>>;
  timeoutMs?: number;
};

/**
 * Performs one provider search using native fetch. Endpoints and fetch are
 * injectable so tests can use local fixtures without touching live services.
 */
export async function search(input: SearchInput): Promise<SearchResponse> {
  if (input.query === "") throw new Error("query is required");
  throwIfAborted(input.signal);

  const provider = selectProvider(input.provider, input.credentials);
  const request = createRequestSignal(input.signal, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const result = await (provider === "exa" ? searchExa(input, request.signal) : searchBrave(input, request.signal));
    throwIfAborted(input.signal);
    return result;
  } catch (error) {
    if (input.signal?.aborted) throw abortedError();
    if (request.timedOut) throw new Error(`search timed out after ${(input.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000} seconds`);
    if (isAbortError(error)) throw abortedError();
    const message = error instanceof Error ? error.message : "search request failed";
    throw new Error(`search failed with ${provider === "exa" ? "Exa" : "Brave"} provider: ${message}`);
  } finally {
    request.cleanup();
  }
}

export function selectProvider(
  explicitProvider: string | undefined,
  credentials: SearchCredentials,
): SearchProvider {
  if (explicitProvider !== undefined && explicitProvider !== "exa" && explicitProvider !== "brave") {
    throw new Error(`unsupported search provider ${JSON.stringify(explicitProvider)}`);
  }

  if (explicitProvider === "exa") {
    if (credentials.exaApiKey === undefined || credentials.exaApiKey === "") {
      throw new Error("EXA_API_KEY is required when --provider exa is selected");
    }
    return "exa";
  }
  if (explicitProvider === "brave") {
    if (credentials.braveApiKey === undefined || credentials.braveApiKey === "") {
      throw new Error("BRAVE_API_KEY is required when --provider brave is selected");
    }
    return "brave";
  }

  if (credentials.exaApiKey === "") {
    throw new Error("EXA_API_KEY is set but empty; provide a valid key or unset it to use Brave");
  }
  if (credentials.exaApiKey !== undefined) return "exa";
  if (credentials.braveApiKey === "") {
    throw new Error("BRAVE_API_KEY is set but empty; provide a valid key or unset it");
  }
  if (credentials.braveApiKey !== undefined) return "brave";
  throw new Error("web search requires EXA_API_KEY or BRAVE_API_KEY");
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found. Try rephrasing your search.\n";
  let output = `Found ${results.length} search results:\n\n`;
  for (const result of results) {
    output += `${result.position}. ${result.title}\n`;
    output += `   URL: ${result.link}\n`;
    output += `   Summary: ${result.snippet}\n\n`;
  }
  return output;
}

async function searchExa(input: SearchInput, signal: AbortSignal): Promise<SearchResponse> {
  const endpoint = `${(input.endpoints?.exa ?? EXA_BASE_URL).replace(/\/$/, "")}/search`;
  const response = await request(input.fetch, endpoint, {
    method: "POST",
    headers: {
      "x-api-key": input.credentials.exaApiKey!,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query: input.query, numResults: MAX_RESULTS, contents: { highlights: true } }),
    signal,
  }, "Exa");
  const data = await json(response, "Exa");
  const rawResults = asArray(data, "results", "Exa");
  return {
    provider: "Exa",
    results: rawResults.slice(0, MAX_RESULTS).map((value, index) => {
      const result = asRecord(value, "Exa");
      const highlights = Array.isArray(result.highlights) ? result.highlights : [];
      const first = highlights.find((highlight): highlight is string => typeof highlight === "string");
      const date = typeof result.publishedDate === "string" ? result.publishedDate : "";
      const author = typeof result.author === "string" ? result.author : "";
      return {
        title: stringValue(result.title),
        link: stringValue(result.url),
        snippet: first ?? [date, author ? `by ${author}` : ""].filter(Boolean).join(" "),
        position: index + 1,
      };
    }),
  };
}

async function searchBrave(input: SearchInput, signal: AbortSignal): Promise<SearchResponse> {
  const base = (input.endpoints?.brave ?? BRAVE_BASE_URL).replace(/\/$/, "");
  const endpoint = `${base}/web/search?q=${encodeURIComponent(input.query)}&count=${MAX_RESULTS}`;
  const response = await request(input.fetch, endpoint, {
    method: "GET",
    headers: { "X-Subscription-Token": input.credentials.braveApiKey!, accept: "application/json" },
    signal,
  }, "Brave");
  const data = asRecord(await json(response, "Brave"), "Brave");
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

async function request(
  fetcher: typeof globalThis.fetch | undefined,
  url: string,
  init: RequestInit,
  provider: ProviderLabel,
): Promise<Response> {
  let response: Response;
  try {
    response = await (fetcher ?? globalThis.fetch)(url, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`${provider} search request failed`);
  }
  if (!response.ok) {
    // Deliberately do not surface remote response bodies: they can contain
    // provider diagnostics or request data, and status is enough to act on.
    throw new Error(`${provider.toLowerCase()} search: HTTP ${response.status}`);
  }
  return response;
}

async function json(response: Response, provider: ProviderLabel): Promise<unknown> {
  let text: string;
  try {
    text = await readText(response);
    return JSON.parse(text);
  } catch {
    throw new Error(`${provider.toLowerCase()} search: invalid JSON response`);
  }
}

async function readText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("response too large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("response too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks, length));
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function asRecord(value: unknown, provider: ProviderLabel): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${provider.toLowerCase()} search: malformed response`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, key: string, provider: ProviderLabel): unknown[] {
  const record = asRecord(value, provider);
  if (!Array.isArray(record[key])) throw new Error(`${provider.toLowerCase()} search: malformed response`);
  return record[key];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

function abortedError(): Error {
  return new Error("Operation aborted");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function createRequestSignal(caller: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(caller?.reason);
  if (caller?.aborted) abort();
  caller?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", abort);
    },
  };
}
