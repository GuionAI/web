import { describe, expect, it, vi } from "vitest";

import {
  createHttpApp,
  createHttpOpenAPIDocument,
  type HttpServiceDependencies,
} from "../src/http.js";
import { RequestTimeoutError, type WebOperations } from "@guionai/web-core";

function operations(overrides: Partial<WebOperations> = {}): WebOperations {
  return {
    search: vi.fn(async () => ({
      provider: "Kepos Bridge" as const,
      results: [],
    })),
    fetch: vi.fn(async (input) => ({
      url: input.url,
      mode: "full" as const,
      content: "page",
    })),
    links: vi.fn(async (input) => ({
      url: input.url,
      links: [],
      truncated: false,
    })),
    docsResolve: vi.fn(async (input) => ({
      query: input.query,
      libraries: [],
    })),
    docsFetch: vi.fn(async (input) => ({
      library_id: input.library_id,
      content: "docs",
    })),
    sgraphSearch: vi.fn(async () => ({ content: "source" })),
    keposBridge: vi.fn(async () => ({ output: "bridge", results: [] })),
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<HttpServiceDependencies> = {},
): HttpServiceDependencies {
  return {
    operations: operations(),
    credentials: { exaApiKey: "exa-secret", context7ApiKey: "ctx-secret" },
    keposBridgeEndpoint: "http://bridge.test/route",
    ...overrides,
  };
}

async function json(
  app: ReturnType<typeof createHttpApp>,
  path: string,
  body: unknown,
): Promise<{ response: Response; body: any }> {
  const response = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

describe("personal HTTP service", () => {
  it("returns an empty successful Bridge search without retrying Exa", async () => {
    const ops = operations();
    const app = createHttpApp({
      ...dependencies(),
      operations: ops,
    });
    const result = await json(app, "/v1/search", { query: "empty" });
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ provider: "Kepos Bridge", results: [] });
    expect(ops.search).toHaveBeenCalledTimes(1);
    expect(ops.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "empty",
        provider: "kepos-bridge",
        keposBridgeEndpoint: "http://bridge.test/route",
        allowEmptyKeposResults: true,
      }),
    );
  });

  it("retries Exa exactly once after a Bridge failure", async () => {
    const ops = operations({
      search: vi
        .fn()
        .mockRejectedValueOnce(new Error("bridge unavailable"))
        .mockResolvedValueOnce({
          provider: "Exa",
          results: [
            {
              title: "result",
              link: "https://example.test",
              snippet: "snippet",
              position: 1,
            },
          ],
        }),
    });
    const app = createHttpApp({ ...dependencies(), operations: ops });
    const result = await json(app, "/v1/search", { query: "fallback" });
    expect(result.response.status).toBe(200);
    expect(result.body.provider).toBe("Exa");
    expect(ops.search).toHaveBeenCalledTimes(2);
    expect(ops.search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: "exa", query: "fallback" }),
    );
  });

  it("treats a non-empty Bridge payload with no usable links as a failure", async () => {
    const ops = operations({
      search: vi
        .fn()
        .mockRejectedValueOnce(new Error("bridge invalid"))
        .mockResolvedValueOnce({ provider: "Exa", results: [] }),
    });
    const app = createHttpApp({ ...dependencies(), operations: ops });
    const result = await json(app, "/v1/search", { query: "invalid" });
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ provider: "Exa", results: [] });
    expect(ops.search).toHaveBeenCalledTimes(2);
  });

  it("does not retry a cancelled Bridge request", async () => {
    const controller = new AbortController();
    const ops = operations({
      search: vi.fn(async ({ signal }) => {
        controller.abort();
        throw new Error("Operation aborted");
      }),
    });
    const app = createHttpApp({ ...dependencies(), operations: ops });
    const response = await app.request("/v1/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "cancel" }),
      signal: controller.signal,
    });
    expect(response.status).toBe(499);
    expect(ops.search).toHaveBeenCalledTimes(1);
  });

  it("maps an Exa timeout after Bridge failure to a documented timeout", async () => {
    const ops = operations({
      search: vi
        .fn()
        .mockRejectedValueOnce(new Error("bridge unavailable"))
        .mockRejectedValueOnce(new RequestTimeoutError("exa timed out", true)),
    });
    const app = createHttpApp({ ...dependencies(), operations: ops });
    const result = await json(app, "/v1/search", { query: "timeout" });
    expect(result.response.status).toBe(504);
    expect(result.body).toEqual({
      code: "upstream_timeout",
      message: "search timed out",
    });
    expect(ops.search).toHaveBeenCalledTimes(2);
  });

  it("keeps Bridge data operations typed, separate, and Bridge-only", async () => {
    const ops = operations({
      keposBridge: vi.fn(async () => ({
        output: "bridge",
        results: [{ future: true }],
        future_field: "ignored",
      })),
    });
    const app = createHttpApp({ ...dependencies(), operations: ops });
    const weather = await json(app, "/v1/weather", {
      location: "Country, Area, City",
      start: "2026-09-01",
      duration: 3,
    });
    expect(weather.response.status).toBe(200);
    expect(weather.body).toEqual({
      output: "bridge",
      results: [{ future: true }],
    });
    await json(app, "/v1/sports", { fn: "schedule", league: "nba" });
    await json(app, "/v1/finance", { ticker: "BTC", type: "crypto" });
    await json(app, "/v1/time", { utc_offset: "+08:00" });
    expect(ops.keposBridge).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        endpoint: "http://bridge.test/route",
        commands: {
          weather: [
            {
              location: "Country, Area, City",
              start: "2026-09-01",
              duration: 3,
            },
          ],
        },
      }),
    );
    expect(ops.keposBridge).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        commands: { sports: [{ fn: "schedule", league: "nba" }] },
      }),
    );
    expect(ops.keposBridge).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        commands: { finance: [{ ticker: "BTC", type: "crypto" }] },
      }),
    );
    expect(ops.keposBridge).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        commands: { time: [{ utc_offset: "+08:00" }] },
      }),
    );
    expect(ops.search).not.toHaveBeenCalled();
  });

  it("forwards every research operation with server credentials and defaults", async () => {
    const ops = operations({
      fetch: vi.fn(async (input) => ({
        url: input.url,
        mode: "tree" as const,
        content: "markdown",
      })),
      links: vi.fn(async (input) => ({
        url: input.url,
        links: [{ text: "docs", url: "https://example.test/docs" }],
        truncated: false,
      })),
      docsResolve: vi.fn(async (input) => ({
        query: input.query,
        libraries: [
          {
            id: "/acme/docs",
            title: "Docs",
            description: "fixture",
            trust_score: 9,
            total_snippets: 2,
          },
        ],
      })),
      docsFetch: vi.fn(async (input) => ({
        library_id: input.library_id,
        content: "documentation",
      })),
      sgraphSearch: vi.fn(async () => ({ content: "source results" })),
    });
    const app = createHttpApp({ ...dependencies(), operations: ops });
    expect(
      (
        await json(app, "/v1/fetch", {
          url: "https://example.test",
          render: "agent-browser",
          waitMs: 0,
        })
      ).body,
    ).toMatchObject({ mode: "tree" });
    expect(
      (await json(app, "/v1/links", { url: "https://example.test" })).body,
    ).toMatchObject({ links: [{ text: "docs" }] });
    expect(
      (await json(app, "/v1/docs/resolve", { query: "acme" })).body,
    ).toMatchObject({ libraries: [{ id: "/acme/docs" }] });
    expect(
      (
        await json(app, "/v1/docs/fetch", {
          library_id: "/acme/docs",
          topic: "install",
        })
      ).body,
    ).toMatchObject({ content: "documentation" });
    expect(
      (await json(app, "/v1/source-search", { query: "repo:acme" })).body,
    ).toEqual({ content: "source results" });
    expect(ops.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.test",
        tree: false,
        full: false,
        tree_threshold: 5000,
        render: "agent-browser",
        waitMs: 0,
      }),
      expect.any(AbortSignal),
    );
    expect(ops.links).toHaveBeenCalledWith(
      { url: "https://example.test", limit: 100, render: "fetch" },
      expect.any(AbortSignal),
    );
    expect(ops.docsResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "acme",
        credentials: { exaApiKey: "exa-secret", context7ApiKey: "ctx-secret" },
      }),
    );
    expect(ops.docsFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        library_id: "/acme/docs",
        topic: "install",
        tokens: 0,
      }),
    );
    expect(ops.sgraphSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "repo:acme",
        count: 10,
        context: 10,
        timeout: 0,
      }),
    );
  });

  it("rejects invalid request bodies before invoking operations", async () => {
    const ops = operations();
    const app = createHttpApp({ ...dependencies(), operations: ops });
    const invalid = await json(app, "/v1/weather", {
      location: "",
      command: "search_query",
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.code).toBe("invalid_request");
    expect(ops.keposBridge).not.toHaveBeenCalled();

    const render = await json(app, "/v1/fetch", {
      url: "https://example.test",
      waitMs: 100,
    });
    expect(render.response.status).toBe(400);
    expect(ops.fetch).not.toHaveBeenCalled();

    const malformed = await app.request("/v1/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_request" });
  });

  it("exposes all typed routes in a generated OpenAPI 3.1 document", () => {
    const document = createHttpOpenAPIDocument("1.2.3");
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.version).toBe("1.2.3");
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([
      "/v1/docs/fetch",
      "/v1/docs/resolve",
      "/v1/fetch",
      "/v1/finance",
      "/v1/links",
      "/v1/search",
      "/v1/source-search",
      "/v1/sports",
      "/v1/time",
      "/v1/weather",
    ]);
    expect(
      Object.keys(document.paths ?? {}).some((path) => path.includes("bridge")),
    ).toBe(false);
  });

  it("requires an Exa key and validates the server-local Bridge endpoint", () => {
    expect(() => createHttpApp({ credentials: {} })).toThrow("EXA_API_KEY");
    expect(() =>
      createHttpApp({
        credentials: { exaApiKey: "key" },
        keposBridgeEndpoint: "https://user:pass@example.test/route",
      }),
    ).toThrow("Kepos Bridge endpoint");
  });
});
