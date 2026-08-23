import { describe, expect, it } from "vitest";

import {
  boundedRequest,
  isOperationAborted,
  isRequestTimeout,
  readResponseText,
} from "../src/request.js";

function pendingFetch(onAbort: () => void): typeof globalThis.fetch {
  return async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        onAbort();
        reject(new DOMException("aborted", "AbortError"));
      });
    });
}

describe("bounded request transport", () => {
  it("propagates caller cancellation to transport and normalizes it", async () => {
    const controller = new AbortController();
    let transportSawAbort = false;
    const pending = boundedRequest(
      pendingFetch(() => {
        transportSawAbort = true;
      }),
      "http://fixture.test",
      {},
      {
        callerSignal: controller.signal,
        timeoutMs: 1_000,
        timeoutMessage: "operation timed out",
      },
      async () => "unreachable",
    );

    controller.abort();
    const error = await pending.catch((reason: unknown) => reason);
    expect(isOperationAborted(error)).toBe(true);
    expect(error).toMatchObject({ message: "Operation aborted" });
    expect(transportSawAbort).toBe(true);
  });

  it("keeps operation timeout distinct from caller cancellation", async () => {
    const operationTimeout = await boundedRequest(
      pendingFetch(() => {}),
      "http://fixture.test",
      {},
      {
        timeoutMs: 1,
        timeoutMessage: "operation timed out",
      },
      async () => "unreachable",
    ).catch((reason: unknown) => reason);
    expect(isRequestTimeout(operationTimeout)).toBe(true);
    expect(operationTimeout).toMatchObject({
      message: "operation timed out",
      operationTimeout: true,
    });

    const transportTimeout = await boundedRequest(
      pendingFetch(() => {}),
      "http://fixture.test",
      {},
      {
        timeoutMs: 1,
        timeoutIsOperationTimeout: false,
        timeoutMessage: "transport timed out",
      },
      async () => "unreachable",
    ).catch((reason: unknown) => reason);
    expect(isRequestTimeout(transportTimeout)).toBe(true);
    expect(transportTimeout).toMatchObject({
      message: "transport timed out",
      operationTimeout: false,
    });
  });

  it("cancels a streamed body when the caller aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    let releasePull!: () => void;
    let startReading!: () => void;
    const readingStarted = new Promise<void>((resolve) => {
      startReading = resolve;
    });
    const pending = boundedRequest(
      async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              startReading();
              return new Promise<void>((resolve) => {
                releasePull = resolve;
              });
            },
            cancel() {
              cancelled = true;
              releasePull();
            },
          }),
        ),
      "http://fixture.test",
      {},
      {
        callerSignal: controller.signal,
        timeoutMs: 1_000,
        timeoutMessage: "timeout",
      },
      (response, signal) => readResponseText(response, 100, signal),
    );
    await readingStarted;
    controller.abort();
    const error = await pending.catch((reason: unknown) => reason);
    expect(isOperationAborted(error)).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("bounds streamed response bytes, cancels the reader, and decodes safely", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("abcd"));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readResponseText(response, 3)).rejects.toThrow(
      "response exceeds 3 byte limit",
    );
    expect(cancelled).toBe(true);

    const truncated = await readResponseText(
      new Response(new TextEncoder().encode("abcdef")),
      3,
      undefined,
      { truncate: true },
    );
    expect(truncated).toBe("abc");
  });
});
