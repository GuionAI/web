type RequestSignalOptions = {
  /** Distinguishes a caller-selected no-deadline transport guard from an operation timeout. */
  timeoutIsOperationTimeout?: boolean;
  timeoutReason?: unknown;
};

export function createRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  options: RequestSignalOptions = {},
) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abort();
  callerSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = options.timeoutIsOperationTimeout ?? true;
    if (options.timeoutReason === undefined) controller.abort();
    else controller.abort(options.timeoutReason);
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abort);
    },
  };
}
