import {
  boundedRequest,
  isOperationAborted,
  isResponseBodyLimit,
  isRequestTimeout,
  readResponseText,
  throwIfAborted,
} from "./request.js";

/** The loopback route used by the Web settings surface when no route is set. */
export const DEFAULT_KEPOS_BRIDGE_ENDPOINT =
  "http://127.0.0.1:8787/codex/web-search" as const;

/** The bridge owns a 45-second request bound; leave a small transport margin. */
export const KEPOS_BRIDGE_TIMEOUT_MS = 50_000 as const;
export const KEPOS_BRIDGE_MAX_REQUEST_BYTES = 64 * 1024;
export const KEPOS_BRIDGE_MAX_RESPONSE_BYTES = 1024 * 1024;
const KEPOS_BRIDGE_COMMANDS = new Set([
  "search_query",
  "weather",
  "sports",
  "finance",
  "time",
]);

export type KeposBridgeCommands = Record<string, unknown>;

/** The only bridge response fields interpreted by Web. */
export type KeposBridgeResponse = {
  output: string;
  results?: unknown[];
};

export type KeposBridgeInput = {
  endpoint?: string;
  commands: KeposBridgeCommands;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/**
 * Validates a complete bridge route without normalizing or extending its path.
 * Credentials, query strings, and fragments are deliberately not accepted.
 */
export function isValidKeposBridgeEndpoint(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    !/^https?:\/\//i.test(value) ||
    value.includes("?") ||
    value.includes("#")
  )
    return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function validateKeposBridgeEndpoint(value: unknown): string {
  if (!isValidKeposBridgeEndpoint(value))
    throw new Error(
      "Kepos Bridge endpoint must be an absolute HTTP(S) URL without credentials, query, or fragment",
    );
  return value;
}

/**
 * Sends one stateless command document to the bridge and validates its bounded
 * JSON response. Unknown response fields and result record shapes are kept
 * opaque for callers that need the specialized result payload.
 */
export async function callKeposBridge(
  input: KeposBridgeInput,
): Promise<KeposBridgeResponse> {
  throwIfAborted(input.signal);
  const endpoint = validateKeposBridgeEndpoint(
    input.endpoint ?? DEFAULT_KEPOS_BRIDGE_ENDPOINT,
  );
  if (
    typeof input.commands !== "object" ||
    input.commands === null ||
    Array.isArray(input.commands) ||
    Object.keys(input.commands).some((key) => !KEPOS_BRIDGE_COMMANDS.has(key))
  )
    throw new Error("Kepos Bridge request contains an unsupported command");
  const timeoutMs = input.timeoutMs ?? KEPOS_BRIDGE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Kepos Bridge timeout must be a positive finite number");

  let body: string;
  try {
    body = JSON.stringify({ commands: input.commands });
  } catch {
    throw new Error("Kepos Bridge request could not be encoded");
  }
  if (body === undefined)
    throw new Error("Kepos Bridge request could not be encoded");
  if (
    new TextEncoder().encode(body).byteLength > KEPOS_BRIDGE_MAX_REQUEST_BYTES
  )
    throw new Error("Kepos Bridge request exceeds the 64 KiB limit");

  try {
    return await boundedRequest(
      input.fetch,
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
      },
      {
        callerSignal: input.signal,
        timeoutMs,
        timeoutMessage: `Kepos Bridge request timed out after ${timeoutMs / 1000} seconds`,
      },
      async (response, signal) => {
        if (!response.ok)
          throw new Error(
            `Kepos Bridge request failed with HTTP ${response.status}`,
          );

        let decoded: unknown;
        try {
          decoded = JSON.parse(
            await readResponseText(
              response,
              KEPOS_BRIDGE_MAX_RESPONSE_BYTES,
              signal,
            ),
          );
        } catch (error) {
          if (
            isOperationAborted(error) ||
            isRequestTimeout(error) ||
            isResponseBodyLimit(error)
          )
            throw error;
          throw new Error("Kepos Bridge returned malformed JSON");
        }
        if (
          typeof decoded !== "object" ||
          decoded === null ||
          Array.isArray(decoded) ||
          typeof (decoded as { output?: unknown }).output !== "string"
        )
          throw new Error("Kepos Bridge returned an invalid response");
        const responseValue = decoded as {
          output: string;
          results?: unknown;
        };
        if (
          responseValue.results !== undefined &&
          !Array.isArray(responseValue.results)
        )
          throw new Error("Kepos Bridge returned an invalid response");
        return {
          output: responseValue.output,
          ...(responseValue.results === undefined
            ? {}
            : { results: responseValue.results }),
        };
      },
    );
  } catch (error) {
    if (
      isOperationAborted(error) ||
      isRequestTimeout(error) ||
      isResponseBodyLimit(error)
    )
      throw error;
    if (error instanceof Error && isSafeBridgeError(error.message)) throw error;
    throw new Error("Kepos Bridge request failed");
  }
}

function isSafeBridgeError(message: string): boolean {
  return (
    /^Kepos Bridge request failed with HTTP \d+$/.test(message) ||
    message === "Kepos Bridge returned malformed JSON" ||
    message === "Kepos Bridge returned an invalid response"
  );
}
