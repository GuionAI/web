export type RequestSignalOptions = {
  /** Distinguishes a caller-selected operation deadline from a transport guard. */
  timeoutIsOperationTimeout?: boolean;
};

export type BoundedRequestOptions = RequestSignalOptions & {
  callerSignal?: AbortSignal;
  timeoutMs: number;
  timeoutMessage: string;
};

export class OperationAbortedError extends Error {
  constructor() {
    super("Operation aborted");
    this.name = "OperationAbortedError";
  }
}

export class RequestTimeoutError extends Error {
  constructor(
    message: string,
    readonly operationTimeout: boolean,
  ) {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

export class ResponseBodyLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`response exceeds ${maxBytes} byte limit`);
    this.name = "ResponseBodyLimitError";
  }
}

/**
 * Runs one fetch with a transport signal that combines caller cancellation and
 * a bounded timeout. The callback owns status handling and decoding while the
 * shared signal/body readers own all transport cleanup.
 */
export async function boundedRequest<T>(
  fetcher: typeof globalThis.fetch | undefined,
  url: string | URL,
  init: RequestInit,
  options: BoundedRequestOptions,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const request = createRequestSignal(
    options.callerSignal,
    options.timeoutMs,
    options,
  );
  try {
    const response = await (fetcher ?? globalThis.fetch)(url, {
      ...init,
      signal: request.signal,
    });
    throwIfAborted(options.callerSignal);
    const result = await consume(response, request.signal);
    throwIfAborted(options.callerSignal);
    return result;
  } catch (error) {
    if (options.callerSignal?.aborted) throw abortedError();
    if (request.timedOut)
      throw new RequestTimeoutError(
        options.timeoutMessage,
        request.operationTimeout,
      );
    if (isAbortError(error)) throw abortedError();
    throw error;
  } finally {
    request.cleanup();
  }
}

/** Reads and bounds a response body without using an unbounded text helper. */
export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  options: { truncate?: boolean } = {},
): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes && !options.truncate)
      throw new ResponseBodyLimitError(maxBytes);
    return options.truncate ? body.slice(0, maxBytes) : body;
  }

  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel();
  };
  if (signal?.aborted) cancelReader();
  else signal?.addEventListener("abort", cancelReader, { once: true });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (!options.truncate) {
          await reader.cancel();
          throw new ResponseBodyLimitError(maxBytes);
        }
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        await reader.cancel();
        total = maxBytes;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Decodes a bounded UTF-8 response body for JSON and text providers. */
export async function readResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  options: { truncate?: boolean } = {},
): Promise<string> {
  const body = await readResponseBytes(response, maxBytes, signal, options);
  return new TextDecoder().decode(body);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

export function isOperationAborted(error: unknown): boolean {
  return error instanceof OperationAbortedError;
}

export function isRequestTimeout(error: unknown): boolean {
  return error instanceof RequestTimeoutError;
}

export function isResponseBodyLimit(error: unknown): boolean {
  return error instanceof ResponseBodyLimitError;
}

function createRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  options: RequestSignalOptions,
) {
  const controller = new AbortController();
  let timedOut = false;
  const operationTimeout = options.timeoutIsOperationTimeout ?? true;
  const abort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abort();
  callerSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    operationTimeout,
    cleanup() {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abort);
    },
  };
}

function abortedError(): OperationAbortedError {
  return new OperationAbortedError();
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
