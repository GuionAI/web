import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_GATEWAY_RENDER_PATH,
  BROWSER_GATEWAY_TIMEOUT_MS,
  fetchWebLinks,
  fetchWebPage,
  OperationAbortedError,
  type BrowserGatewayPage,
} from "../src/index.js";

const publicTarget = { resolveHost: async () => ["93.184.216.34"] };

function renderedPage(
  overrides: Partial<BrowserGatewayPage> = {},
): BrowserGatewayPage {
  return {
    html: "<html><body><article><h1>Rendered page</h1><p>Gateway content.</p></article></body></html>",
    url: "https://render.test/final/page",
    ...overrides,
  };
}

describe("Browser Rendering Gateway fetch seam", () => {
  it("keeps Fetch extraction and Links navigation on gateway HTML and final URL", async () => {
    const transport = vi.fn(async (request) => {
      expect(request.url).toBe("https://render.test/start");
      expect(request.waitMs).toBe(1_250);
      return renderedPage({
        html: '<html><head><base href="/docs/"></head><body><article><h1>Rendered page</h1><p>Gateway content.</p></article><a href="next">Next</a></body></html>',
      });
    });
    const options = {
      ...publicTarget,
      browserGateway: { transport },
    };

    await expect(
      fetchWebPage(
        {
          url: "https://render.test/start",
          render: "browser",
          waitMs: 1_250,
          mode: "full",
        },
        undefined,
        options,
      ),
    ).resolves.toEqual({
      url: "https://render.test/start",
      mode: "full",
      content: "Gateway content.\n",
      truncated: false,
    });

    await expect(
      fetchWebLinks(
        {
          url: "https://render.test/start",
          render: "browser",
          waitMs: 1_250,
        },
        undefined,
        options,
      ),
    ).resolves.toEqual({
      url: "https://render.test/start",
      links: [{ text: "Next", url: "https://render.test/docs/next" }],
      truncated: false,
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("posts the bounded raw-render contract to the configured gateway", async () => {
    let receivedURL = "";
    let receivedInit: RequestInit | undefined;
    const result = await fetchWebPage(
      {
        url: "https://render.test/page",
        render: "browser",
        waitMs: 0,
        mode: "full",
      },
      undefined,
      {
        ...publicTarget,
        browserGateway: {
          baseUrl: "http://browser-gateway",
          fetch: async (url, init) => {
            receivedURL = String(url);
            receivedInit = init;
            return Response.json(renderedPage());
          },
        },
      },
    );

    expect(receivedURL).toBe(
      `http://browser-gateway${BROWSER_GATEWAY_RENDER_PATH}`,
    );
    expect(receivedInit?.method).toBe("POST");
    expect(new Headers(receivedInit?.headers).get("accept")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(receivedInit?.body))).toEqual({
      url: "https://render.test/page",
      waitMs: 0,
    });
    expect(result.content).toBe("Gateway content.\n");
  });

  it("fails explicitly when the gateway is missing, overloaded, unreachable, or malformed", async () => {
    await expect(
      fetchWebPage(
        { url: "https://render.test/page", render: "browser", waitMs: 0 },
        undefined,
        { ...publicTarget, browserGateway: {} },
      ),
    ).rejects.toMatchObject({ code: "render_unavailable" });

    for (const status of [429, 503]) {
      await expect(
        fetchWebPage(
          { url: "https://render.test/page", render: "browser", waitMs: 0 },
          undefined,
          {
            ...publicTarget,
            browserGateway: {
              baseUrl: "http://browser-gateway",
              fetch: async () => new Response("busy", { status }),
            },
          },
        ),
      ).rejects.toMatchObject({ code: "render_unavailable" });
    }

    await expect(
      fetchWebPage(
        { url: "https://render.test/page", render: "browser", waitMs: 0 },
        undefined,
        {
          ...publicTarget,
          browserGateway: {
            baseUrl: "http://browser-gateway",
            fetch: async () => new Response("upstream", { status: 502 }),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "render_failed" });

    await expect(
      fetchWebPage(
        { url: "https://render.test/page", render: "browser", waitMs: 0 },
        undefined,
        {
          ...publicTarget,
          browserGateway: {
            baseUrl: "http://browser-gateway",
            fetch: async () => new Response("not-json"),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "render_invalid_output" });

    await expect(
      fetchWebPage(
        { url: "https://render.test/page", render: "browser", waitMs: 0 },
        undefined,
        {
          ...publicTarget,
          browserGateway: {
            baseUrl: "http://browser-gateway",
            fetch: async () => Response.json({ html: "missing url" }),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "render_invalid_output" });

    await expect(
      fetchWebPage(
        { url: "https://render.test/page", render: "browser", waitMs: 0 },
        undefined,
        {
          ...publicTarget,
          browserGateway: {
            baseUrl: "http://browser-gateway",
            fetch: async () => {
              throw new Error("connection refused");
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "render_unavailable" });
  });

  it("preserves caller cancellation through gateway transport", async () => {
    const controller = new AbortController();
    let sawSignal = false;
    let started = false;
    const pending = fetchWebPage(
      { url: "https://render.test/page", render: "browser", waitMs: 0 },
      controller.signal,
      {
        ...publicTarget,
        browserGateway: {
          transport: async ({ signal }) => {
            started = true;
            return new Promise<BrowserGatewayPage>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  sawSignal = true;
                  reject(new OperationAbortedError());
                },
                { once: true },
              );
            });
          },
        },
      },
    );
    for (let attempt = 0; attempt < 100 && !started; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: "OperationAbortedError",
    });
    expect(sawSignal).toBe(true);
  });

  it("aborts the gateway HTTP request when the caller cancels", async () => {
    const controller = new AbortController();
    let sawAbort = false;
    const pending = fetchWebPage(
      { url: "https://93.184.216.34/page", render: "browser", waitMs: 0 },
      controller.signal,
      {
        browserGateway: {
          baseUrl: "http://browser-gateway",
          fetch: async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  sawAbort = true;
                  reject(new DOMException("aborted", "AbortError"));
                },
                { once: true },
              );
            }),
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: "OperationAbortedError",
    });
    expect(sawAbort).toBe(true);
  });

  it("bounds a pending gateway request", async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    const pending = fetchWebPage(
      { url: "https://93.184.216.34/page", render: "browser", waitMs: 0 },
      undefined,
      {
        browserGateway: {
          baseUrl: "http://browser-gateway",
          timeoutMs: 50,
          fetch: async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  sawAbort = true;
                  reject(new DOMException("aborted", "AbortError"));
                },
                { once: true },
              );
            }),
        },
      },
    );
    try {
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(50);
      await expect(outcome).resolves.toMatchObject({
        code: "render_timed_out",
      });
      expect(sawAbort).toBe(true);
      expect(BROWSER_GATEWAY_TIMEOUT_MS).toBe(50_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
