import { createRequestSignal } from "./request.js";

const CONTEXT7_BASE_URL = "https://context7.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4096;

export type Context7Credentials = {
  /** Undefined permits Context7's anonymous API tier; an empty value is invalid. */
  context7ApiKey?: string;
};

export type DocsLibrary = {
  id: string;
  title: string;
  description: string;
  trust_score: number;
  total_snippets: number;
  versions?: string[];
};

export type DocsResolveResult = {
  query: string;
  libraries: DocsLibrary[];
};

export type DocsFetchResult = {
  library_id: string;
  topic?: string;
  content: string;
};

type Context7Options = {
  credentials: Context7Credentials;
  signal?: AbortSignal;
  /** Injectable for test-owned local Context7 fixtures. */
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export type DocsResolveInput = Context7Options & { query: string };
export type DocsFetchInput = Context7Options & {
  library_id: string;
  topic?: string;
  tokens?: number;
};

export type DocsToolInput =
  | { action: "resolve"; query: string }
  | { action: "fetch"; library_id: string; topic?: string; tokens?: number };

/** Normalizes the action-shaped documentation input shared by host adapters. */
export function normalizeDocsToolInput(
  input: Record<string, unknown>,
): DocsToolInput {
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
    return { action: "resolve", query: requireDocsString(input, "query") };
  }
  if ("query" in input)
    throw new Error('web_docs action "fetch" does not accept query');
  const library_id = requireDocsString(input, "library_id");
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

function requireDocsString(
  input: Record<string, unknown>,
  field: string,
): string {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${field} must be a non-empty string`);
  return value;
}

/** Resolves a library query using Context7 v1. */
export async function docsResolve(
  input: DocsResolveInput,
): Promise<DocsResolveResult> {
  if (input.query === "") throw new Error("query is required");
  const apiKey = validateApiKey(input.credentials);
  throwIfAborted(input.signal);

  const url = new URL(`${baseURL(input.endpoint)}/api/v1/search`);
  url.searchParams.set("query", input.query);
  const data = await context7Request(
    "resolve",
    url,
    apiKey,
    input,
    (response, signal) => responseJson(response, "resolve", signal),
  );
  const results = record(data, "context7 resolve").results;
  if (!Array.isArray(results))
    throw new Error("context7 resolve: malformed response");

  const libraries = results.map((value) => library(value));
  if (libraries.length === 0)
    throw new Error(`no libraries found for ${JSON.stringify(input.query)}`);
  return { query: input.query, libraries };
}

/** Fetches Context7 v1 plain-text documentation for a resolved library ID. */
export async function docsFetch(
  input: DocsFetchInput,
): Promise<DocsFetchResult> {
  const apiKey = validateApiKey(input.credentials);
  throwIfAborted(input.signal);

  const libraryID = normalizeLibraryID(input.library_id);
  // Context7 v1 accepts slash-delimited IDs in its path. The normalized public
  // ID has one slash, so remove exactly that slash when building this path.
  const pathID = libraryID.slice(1);
  const url = new URL(`${baseURL(input.endpoint)}/api/v1/${pathID}`);
  url.searchParams.set("type", "txt");
  if (input.topic !== undefined && input.topic !== "")
    url.searchParams.set("topic", input.topic);
  if (input.tokens !== undefined && input.tokens > 0)
    url.searchParams.set("tokens", String(input.tokens));

  const content = await context7Request(
    "docs",
    url,
    apiKey,
    input,
    (response, signal) => responseText(response, "docs", signal),
  );
  const result: DocsFetchResult = { library_id: libraryID, content };
  if (input.topic !== undefined && input.topic !== "")
    result.topic = input.topic;
  return result;
}

/** Returns the public Context7 form of an ID: exactly one leading slash. */
export function normalizeLibraryID(id: string): string {
  if (id === "") return "";
  return `/${id.replace(/^\/+/, "")}`;
}

function library(value: unknown): DocsLibrary {
  const item = record(value, "context7 resolve");
  const versions = Array.isArray(item.versions)
    ? item.versions.filter(
        (version): version is string => typeof version === "string",
      )
    : [];
  return {
    id: normalizeLibraryID(stringValue(item.id)),
    title: stringValue(item.title),
    description: stringValue(item.description),
    trust_score: numberValue(item.trustScore),
    total_snippets: integerValue(item.totalSnippets),
    ...(versions.length > 0 ? { versions } : {}),
  };
}

async function context7Request<T>(
  operation: "resolve" | "docs",
  url: URL,
  apiKey: string | undefined,
  input: Context7Options,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const request = createRequestSignal(
    input.signal,
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const headers = new Headers({
      accept: operation === "resolve" ? "application/json" : "text/plain",
    });
    if (apiKey !== undefined) headers.set("Authorization", `Bearer ${apiKey}`);
    const response = await (input.fetch ?? globalThis.fetch)(url, {
      method: "GET",
      headers,
      signal: request.signal,
    });
    throwIfAborted(input.signal);
    if (!response.ok) throw await httpError(operation, response, apiKey);
    const result = await consume(response, request.signal);
    throwIfAborted(input.signal);
    return result;
  } catch (error) {
    if (input.signal?.aborted) throw abortedError();
    if (request.timedOut)
      throw new Error(
        `context7 ${operation} timed out after ${(input.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000} seconds`,
      );
    if (isAbortError(error)) throw abortedError();
    if (error instanceof Error && error.message.startsWith("context7 "))
      throw error;
    throw new Error(`context7 ${operation}: request failed`);
  } finally {
    request.cleanup();
  }
}

async function responseJson(
  response: Response,
  operation: "resolve" | "docs",
  signal: AbortSignal,
): Promise<unknown> {
  try {
    return JSON.parse(await readText(response, MAX_RESPONSE_BYTES, signal));
  } catch (error) {
    if (error instanceof Error && error.message === "response too large")
      throw new Error(`context7 ${operation}: response too large`);
    throw new Error(`context7 ${operation}: invalid JSON response`);
  }
}

async function responseText(
  response: Response,
  operation: "resolve" | "docs",
  signal: AbortSignal,
): Promise<string> {
  try {
    return await readText(response, MAX_RESPONSE_BYTES, signal);
  } catch (error) {
    if (error instanceof Error && error.message === "response too large")
      throw new Error(`context7 ${operation}: response too large`);
    throw new Error(`context7 ${operation}: read body failed`);
  }
}

async function httpError(
  operation: "resolve" | "docs",
  response: Response,
  apiKey: string | undefined,
): Promise<Error> {
  const body = redact(await readErrorText(response), apiKey);
  const suffix = body === "" ? "" : `: ${body}`;
  switch (response.status) {
    case 202:
      return new Error(
        `context7 ${operation}: library still indexing (HTTP 202) — try again in a few minutes`,
      );
    case 401:
      return new Error(
        `context7 ${operation}: invalid CONTEXT7_API_KEY (HTTP 401) — keys start with 'ctx7sk'`,
      );
    case 404:
      return new Error(
        `context7 ${operation}: not found (HTTP 404)${operation === "docs" ? ". Run 'web docs resolve <name>' to find the correct library ID" : ""}`,
      );
    case 429:
      return new Error(
        `context7 ${operation}: rate limited (HTTP 429) — set CONTEXT7_API_KEY for higher limits`,
      );
    default:
      return new Error(
        `context7 ${operation}: HTTP ${response.status}${suffix}`,
      );
  }
}

async function readErrorText(response: Response): Promise<string> {
  if (!response.body)
    return (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = MAX_ERROR_BODY_BYTES - size;
      chunks.push(value.slice(0, remaining));
      size += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) await reader.cancel();
    }
  } catch {
    return "";
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function readText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes)
      throw new Error("response too large");
    return text;
  }
  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel();
  };
  if (signal?.aborted) cancelReader();
  else signal?.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function validateApiKey(credentials: Context7Credentials): string | undefined {
  const apiKey = credentials.context7ApiKey;
  if (apiKey !== undefined && apiKey.trim() === "") {
    throw new Error(
      "CONTEXT7_API_KEY is set but empty; provide a key or unset it",
    );
  }
  return apiKey?.trim();
}

function baseURL(endpoint: string | undefined): string {
  return (endpoint ?? CONTEXT7_BASE_URL).replace(/\/$/, "");
}

function record(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${operation}: malformed response`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function redact(body: string, apiKey: string | undefined): string {
  const bounded = body.trim().slice(0, MAX_ERROR_BODY_BYTES);
  return apiKey === undefined
    ? bounded
    : bounded.replaceAll(apiKey, "[redacted]");
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
