import {
  boundedRequest,
  isOperationAborted,
  isRequestTimeout,
  isResponseBodyLimit,
  OperationAbortedError,
  readResponseText,
  throwIfAborted,
} from "./request.js";

/** The raw-render operation exposed by the in-cluster Browser Rendering Gateway. */
export const BROWSER_GATEWAY_RENDER_PATH = "/api/render" as const;

/** Leave a small transport margin below the gateway's browser budget. */
export const BROWSER_GATEWAY_TIMEOUT_MS = 50_000 as const;
export const BROWSER_GATEWAY_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export type BrowserGatewayPage = {
  html: string;
  /** The post-redirect URL reported by the gateway. */
  url: string;
};

export type BrowserGatewayRequest = {
  url: string;
  waitMs: number;
  signal?: AbortSignal;
};

/** Test-owned transport seam for a gateway request without a live service. */
export type BrowserGatewayTransport = (
  request: BrowserGatewayRequest,
) => Promise<BrowserGatewayPage>;

export type BrowserGatewayOptions = {
  /** Server-local gateway origin; browser requests fail explicitly when absent. */
  baseUrl?: string;
  /** Test-owned transport that replaces the HTTP request. */
  transport?: BrowserGatewayTransport;
  /** Test-owned HTTP implementation for the gateway request. */
  fetch?: typeof globalThis.fetch;
  /** Bounded gateway request timeout override for tests. */
  timeoutMs?: number;
};

export type BrowserGatewayFailure =
  | "unavailable"
  | "timed_out"
  | "output_too_large"
  | "invalid_output"
  | "failed";

/** A bounded, normalized failure from the gateway boundary. */
export class BrowserGatewayError extends Error {
  constructor(readonly kind: BrowserGatewayFailure) {
    super(`browser gateway ${kind}`);
    this.name = "BrowserGatewayError";
  }
}

/**
 * Requests raw rendered HTML from the gateway and validates only its stable
 * response contract. Markdown extraction and link handling remain in fetch.ts.
 */
export async function renderThroughBrowserGateway(
  options: BrowserGatewayOptions,
  request: BrowserGatewayRequest,
): Promise<BrowserGatewayPage> {
  throwIfAborted(request.signal);
  if (
    !Number.isInteger(request.waitMs) ||
    request.waitMs < 0 ||
    request.waitMs > 30_000
  )
    throw new BrowserGatewayError("failed");

  if (options.transport !== undefined) {
    try {
      const page = await awaitWithAbort(
        options.transport(request),
        request.signal,
      );
      throwIfAborted(request.signal);
      return validateGatewayPage(page);
    } catch (error) {
      throw normalizeGatewayError(error, request.signal);
    }
  }

  const endpoint = gatewayRenderEndpoint(options.baseUrl);
  if (endpoint === undefined) throw new BrowserGatewayError("unavailable");
  const timeoutMs = options.timeoutMs ?? BROWSER_GATEWAY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new BrowserGatewayError("unavailable");

  let body: string;
  try {
    body = JSON.stringify({ url: request.url, waitMs: request.waitMs });
  } catch {
    throw new BrowserGatewayError("failed");
  }

  try {
    return await boundedRequest(
      options.fetch,
      endpoint,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body,
      },
      {
        callerSignal: request.signal,
        timeoutMs,
        timeoutMessage: `browser gateway request timed out after ${timeoutMs / 1000} seconds`,
      },
      async (response, signal) => {
        if (!response.ok) throw new BrowserGatewayHTTPError(response.status);
        let decoded: unknown;
        try {
          decoded = JSON.parse(
            await readResponseText(
              response,
              BROWSER_GATEWAY_MAX_RESPONSE_BYTES,
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
          throw new BrowserGatewayError("invalid_output");
        }
        throwIfAborted(request.signal);
        return validateGatewayPage(decoded);
      },
    );
  } catch (error) {
    throw normalizeGatewayError(error, request.signal);
  }
}

function gatewayRenderEndpoint(
  baseUrl: string | undefined,
): string | undefined {
  if (
    typeof baseUrl !== "string" ||
    baseUrl.length === 0 ||
    baseUrl.trim() !== baseUrl
  )
    return undefined;
  try {
    const base = new URL(baseUrl);
    if (
      (base.protocol !== "http:" && base.protocol !== "https:") ||
      base.username !== "" ||
      base.password !== "" ||
      base.search !== "" ||
      base.hash !== ""
    )
      return undefined;
    return new URL(BROWSER_GATEWAY_RENDER_PATH, base).href;
  } catch {
    return undefined;
  }
}

function validateGatewayPage(value: unknown): BrowserGatewayPage {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { html?: unknown }).html !== "string" ||
    typeof (value as { url?: unknown }).url !== "string"
  )
    throw new BrowserGatewayError("invalid_output");

  const html = (value as { html: string }).html;
  const url = (value as { url: string }).url;
  if (
    new TextEncoder().encode(html).byteLength >
    BROWSER_GATEWAY_MAX_RESPONSE_BYTES
  )
    throw new BrowserGatewayError("output_too_large");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("unsupported rendered URL protocol");
  } catch {
    throw new BrowserGatewayError("invalid_output");
  }
  return { html, url };
}

class BrowserGatewayHTTPError extends Error {
  constructor(readonly status: number) {
    super(`browser gateway HTTP ${status}`);
    this.name = "BrowserGatewayHTTPError";
  }
}

function normalizeGatewayError(
  error: unknown,
  signal: AbortSignal | undefined,
): Error {
  if (signal?.aborted || isOperationAborted(error) || isAbortError(error))
    return new OperationAbortedError();
  if (error instanceof BrowserGatewayError) return error;
  if (isRequestTimeout(error)) return new BrowserGatewayError("timed_out");
  if (isResponseBodyLimit(error))
    return new BrowserGatewayError("output_too_large");
  if (error instanceof BrowserGatewayHTTPError) {
    if (error.status === 408 || error.status === 504)
      return new BrowserGatewayError("timed_out");
    if (error.status === 429 || error.status === 500 || error.status === 503)
      return new BrowserGatewayError("unavailable");
    if (error.status >= 500) return new BrowserGatewayError("failed");
    return new BrowserGatewayError("failed");
  }
  // Network failures are intentionally opaque to callers and explicit about
  // the unavailable gateway boundary rather than falling back to HTTP.
  return new BrowserGatewayError("unavailable");
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function awaitWithAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new OperationAbortedError());
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
