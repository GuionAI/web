const SOURCEGRAPH_ENDPOINT = "https://sourcegraph.com/.api/graphql";
const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;
const DEFAULT_CONTEXT = 10;
const MAX_TIMEOUT_SECONDS = 120;
const TRANSPORT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_GRAPHQL_ERROR_MESSAGE_CHARS = 4096;

const GRAPHQL_QUERY =
  "query Search($query: String!) { " +
  "search(query: $query, version: V2, patternType: keyword) { " +
  "results { matchCount, limitHit, resultCount, results { __typename, ... on FileMatch { " +
  "repository { name }, file { path, url, content }, " +
  "lineMatches { preview, lineNumber } } } } } }";

export type SGraphInput = {
  query: string;
  count?: number;
  context?: number;
  /** Timeout in seconds. Zero disables this operation-specific timeout. */
  timeout?: number;
  signal?: AbortSignal;
  /** Injectable only so tests and host adapters can use local fixtures. */
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
};

export type SGraphResult = {
  content: string;
};

/** Queries Sourcegraph's public GraphQL code-search endpoint with native fetch. */
export async function sgraphSearch(input: SGraphInput): Promise<SGraphResult> {
  if (input.query === "") throw new Error("query is required");
  throwIfAborted(input.signal);

  const count = normalizeCount(input.count);
  const context = normalizeContext(input.context);
  const timeout = normalizeTimeout(input.timeout);
  const request = createRequestSignal(input.signal, timeout);

  try {
    const response = await (input.fetch ?? globalThis.fetch)(
      input.endpoint ?? SOURCEGRAPH_ENDPOINT,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "guionai-web/1.0",
        },
        body: JSON.stringify({
          query: GRAPHQL_QUERY,
          variables: { query: input.query },
        }),
        signal: request.signal,
      },
    );
    throwIfAborted(input.signal);
    throwIfTimedOut(request.timedOut, timeout);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`sourcegraph search: HTTP ${response.status}`);
    }

    let data: unknown;
    try {
      data = JSON.parse(await readText(response, request.signal));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("sourcegraph search:")
      )
        throw error;
      throw new Error("sourcegraph search: invalid JSON response");
    }
    throwIfAborted(input.signal);
    throwIfTimedOut(request.timedOut, timeout);
    return { content: formatSourcegraphResults(data, context, count) };
  } catch (error) {
    if (input.signal?.aborted) throw abortedError();
    if (request.timedOut)
      throw new Error(`sourcegraph search timed out after ${timeout} seconds`);
    if (isAbortError(error)) throw abortedError();
    if (error instanceof Error) throw error;
    throw new Error("sourcegraph search: request failed");
  } finally {
    request.cleanup();
  }
}

/** Formats Sourcegraph's GraphQL response exactly as the established CLI output. */
export function formatSourcegraphResults(
  result: unknown,
  contextWindow: number,
  maxResults: number,
): string {
  const root = record(result);
  const errors = root.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    let output = "## Sourcegraph API Error\n\n";
    for (const error of errors) {
      const message = stringValue(recordOrUndefined(error)?.message);
      if (message !== "")
        output += `- ${message.slice(0, MAX_GRAPHQL_ERROR_MESSAGE_CHARS)}\n`;
    }
    return output;
  }

  const data = recordOrUndefined(root.data);
  if (!data) throw new Error("invalid response format: missing data field");
  const search = recordOrUndefined(data.search);
  if (!search) throw new Error("invalid response format: missing search field");
  const searchResults = recordOrUndefined(search.results);
  if (!searchResults)
    throw new Error("invalid response format: missing results field");

  const matchCount = numberValue(searchResults.matchCount);
  const resultCount = numberValue(searchResults.resultCount);
  const limitHit = searchResults.limitHit === true;
  let output = "# Sourcegraph Search Results\n\n";
  output += `Found ${Math.trunc(matchCount)} matches across ${Math.trunc(resultCount)} results\n`;
  if (limitHit) output += "(Result limit reached, try a more specific query)\n";
  output += "\n";

  const rawResults = searchResults.results;
  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    return output + "No results found. Try a different query.\n";
  }

  for (const [index, value] of rawResults
    .slice(0, Math.max(1, maxResults))
    .entries()) {
    const fileMatch = recordOrUndefined(value);
    if (!fileMatch || fileMatch.__typename !== "FileMatch") continue;
    const repository = recordOrUndefined(fileMatch.repository);
    const file = recordOrUndefined(fileMatch.file);
    if (!repository || !file) continue;

    const repositoryName = stringValue(repository.name);
    const filePath = stringValue(file.path);
    const fileURL = stringValue(file.url);
    const fileContent = stringValue(file.content);
    output += `## Result ${index + 1}: ${repositoryName}/${filePath}\n\n`;
    if (fileURL !== "") output += `URL: ${fileURL}\n\n`;

    if (!Array.isArray(fileMatch.lineMatches)) continue;
    for (const value of fileMatch.lineMatches) {
      const lineMatch = recordOrUndefined(value);
      if (!lineMatch) continue;
      const lineNumber = Math.trunc(numberValue(lineMatch.lineNumber));
      const preview = stringValue(lineMatch.preview);
      if (fileContent === "") {
        output += `\`\`\`\n${lineNumber}| ${preview}\n\`\`\`\n\n`;
        continue;
      }

      const lines = fileContent.split("\n");
      output += "```\n";
      const startLine = Math.max(1, lineNumber - contextWindow);
      for (
        let line = startLine;
        line < lineNumber && line <= lines.length;
        line += 1
      ) {
        output += `${line}| ${lines[line - 1]}\n`;
      }
      output += `${lineNumber}|  ${preview}\n`;
      const endLine = lineNumber + contextWindow;
      for (
        let line = lineNumber + 1;
        line <= endLine && line <= lines.length;
        line += 1
      ) {
        output += `${line}| ${lines[line - 1]}\n`;
      }
      output += "```\n\n";
    }
  }
  return output;
}

function normalizeCount(count: number | undefined): number {
  if (count === undefined || count <= 0) return DEFAULT_COUNT;
  return Math.min(count, MAX_COUNT);
}

function normalizeContext(context: number | undefined): number {
  return context === undefined || context <= 0 ? DEFAULT_CONTEXT : context;
}

function normalizeTimeout(timeout: number | undefined): number {
  if (timeout === undefined || timeout <= 0) return 0;
  return Math.min(timeout, MAX_TIMEOUT_SECONDS);
}

async function readText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
      throw new Error("sourcegraph search: response too large");
    return text;
  }
  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel();
  };
  if (signal.aborted) cancelReader();
  else signal.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("sourcegraph search: response too large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder().decode(output);
  } catch {
    throw new Error("sourcegraph search: invalid response body");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid response format: missing data field");
  return value as Record<string, unknown>;
}

function recordOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

function abortedError(): Error {
  return new Error("Operation aborted");
}

function throwIfTimedOut(timedOut: boolean, timeout: number): void {
  if (timedOut)
    throw new Error(`sourcegraph search timed out after ${timeout} seconds`);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createRequestSignal(caller: AbortSignal | undefined, timeout: number) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(caller?.reason);
  if (caller?.aborted) abort();
  caller?.addEventListener("abort", abort, { once: true });
  const timeoutMs = timeout > 0 ? timeout * 1000 : TRANSPORT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = timeout > 0;
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
