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
    credentials: { exaApiKey: "exa-secret" },
    keposBridgeEndpoint: "http://bridge.test/route",
    ...overrides,
  };
}

async function json(
  app: ReturnType<typeof createHttpApp>,
  path: string,
  body: unknown,
): Promise<{ response: Response; body: unknown }> {
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
    const app = createHttpApp({ ...dependencies(), operations: ops });

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
        .mockResolvedValueOnce({ provider: "Exa", results: [] }),
    });
    const app = createHttpApp({ ...dependencies(), operations: ops });

    const result = await json(app, "/v1/search", { query: "fallback" });

    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ provider: "Exa", results: [] });
    expect(ops.search).toHaveBeenCalledTimes(2);
    expect(ops.search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: "exa", query: "fallback" }),
    );
  });

  it("does not retry a cancelled Bridge request", async () => {
    const controller = new AbortController();
    const ops = operations({
      search: vi.fn(async () => {
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
  });

  it("selects DeepSeek from server-local configuration without fallback", async () => {
    const ops = operations({
      search: vi.fn(async () => ({
        provider: "DeepSeek" as const,
        results: [],
      })),
    });
    const app = createHttpApp({
      ...dependencies(),
      operations: ops,
      credentials: { deepseekApiKey: "deepseek-secret" },
      environment: { WEB_SEARCH_PROVIDER: "deepseek" },
    });

    const result = await json(app, "/v1/search", { query: "selected" });

    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ provider: "DeepSeek", results: [] });
    expect(ops.search).toHaveBeenCalledTimes(1);
    expect(ops.search).toHaveBeenCalledWith({
      query: "selected",
      provider: "deepseek",
      credentials: { deepseekApiKey: "deepseek-secret" },
      signal: expect.any(AbortSignal),
    });
  });

  it("returns a DeepSeek failure without trying another provider", async () => {
    const ops = operations({
      search: vi.fn(async () => {
        throw new Error("deepseek unavailable");
      }),
    });
    const app = createHttpApp({
      ...dependencies(),
      operations: ops,
      credentials: { deepseekApiKey: "deepseek-secret" },
      environment: { WEB_SEARCH_PROVIDER: "deepseek" },
    });

    const result = await json(app, "/v1/search", { query: "failure" });

    expect(result.response.status).toBe(502);
    expect(result.body).toEqual({
      code: "upstream_error",
      message: "search failed",
    });
    expect(ops.search).toHaveBeenCalledTimes(1);
  });

  it("does not start HTTP DeepSeek mode without its server-local key", () => {
    expect(() =>
      createHttpApp({
        credentials: { exaApiKey: "exa-secret" },
        environment: { WEB_SEARCH_PROVIDER: "deepseek" },
      }),
    ).toThrow("DEEPSEEK_API_KEY");
  });

  it("does not expose an HTTP request provider field", () => {
    const document = createHttpOpenAPIDocument();
    const schema = (document.components?.schemas as any).SearchRequest;
    expect(schema.properties.provider).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it("forwards fetch with its explicit rendered-fetch contract", async () => {
    const ops = operations({
      fetch: vi.fn(async (input) => ({
        url: input.url,
        mode: "tree" as const,
        content: "markdown",
      })),
    });
    const app = createHttpApp({ ...dependencies(), operations: ops });

    const result = await json(app, "/v1/fetch", {
      url: "https://example.test",
      render: "browser",
      waitMs: 0,
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({ mode: "tree" });
    expect(ops.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.test",
        full: false,
        render: "browser",
        waitMs: 0,
      }),
      expect.any(AbortSignal),
    );
  });

  it("forwards links with the same explicit rendered-fetch contract", async () => {
    const ops = operations({
      links: vi.fn(async (input) => ({
        url: input.url,
        links: [{ text: "Docs", url: "https://example.test/docs" }],
        truncated: false,
      })),
    });
    const app = createHttpApp({ ...dependencies(), operations: ops });

    const result = await json(app, "/v1/links", {
      url: "https://example.test",
      render: "browser",
      waitMs: 0,
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({
      links: [{ text: "Docs", url: "https://example.test/docs" }],
    });
    expect(ops.links).toHaveBeenCalledWith(
      {
        url: "https://example.test",
        limit: 100,
        render: "browser",
        waitMs: 0,
      },
      expect.any(AbortSignal),
    );
  });

  it("rejects invalid search and fetch requests before an operation", async () => {
    const ops = operations();
    const app = createHttpApp({ ...dependencies(), operations: ops });

    expect((await json(app, "/v1/search", { query: "" })).response.status).toBe(
      400,
    );
    expect(
      (
        await json(app, "/v1/fetch", {
          url: "https://example.test",
          waitMs: 100,
        })
      ).response.status,
    ).toBe(400);
    expect(
      (
        await json(app, "/v1/links", {
          url: "https://example.test",
          waitMs: 100,
        })
      ).response.status,
    ).toBe(400);
    expect(
      (
        await json(app, "/v1/fetch", {
          url: "https://example.test",
          full: true,
          section_id: "intro",
        })
      ).response.status,
    ).toBe(400);
    expect(
      (
        await json(app, "/v1/fetch", {
          url: "https://example.test",
          tree: true,
        })
      ).response.status,
    ).toBe(400);
    expect(ops.search).not.toHaveBeenCalled();
    expect(ops.fetch).not.toHaveBeenCalled();
    expect(ops.links).not.toHaveBeenCalled();

    const malformed = await app.request("/v1/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_request" });
  });

  it.each([
    "/v1/docs/resolve",
    "/v1/docs/fetch",
    "/v1/source-search",
    "/v1/weather",
    "/v1/sports",
    "/v1/finance",
    "/v1/time",
  ])("does not expose %s", async (path) => {
    const ops = operations();
    const app = createHttpApp({ ...dependencies(), operations: ops });

    const result = await json(app, path, {});

    expect(result.response.status).toBe(404);
    expect(result.body).toEqual({
      code: "not_found",
      message: "Route not found",
    });
    for (const operation of Object.values(ops))
      expect(operation).not.toHaveBeenCalled();
  });

  it("exposes search, fetch, and links in a generated OpenAPI 3.1 document", () => {
    const document = createHttpOpenAPIDocument("1.2.3");

    expect(document.openapi).toBe("3.1.0");
    expect(document.info.version).toBe("1.2.3");
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([
      "/v1/fetch",
      "/v1/links",
      "/v1/search",
    ]);
    expect(
      (document.components?.schemas as any).SearchResponse.properties.provider
        .enum,
    ).toEqual(["Exa", "DeepSeek", "Kepos Bridge"]);
    const fetchRequest = (document.components?.schemas as any).FetchRequest;
    expect(fetchRequest.properties.render.enum).toEqual(["http", "browser"]);
    expect(fetchRequest.properties.tree).toBeUndefined();
    expect(fetchRequest.properties.tree_threshold).toBeUndefined();
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
