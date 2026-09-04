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
      truncated: false,
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

    const result = await json(app, "/api/v1/web/search", { query: "empty" });

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

    const result = await json(app, "/api/v1/web/search", { query: "fallback" });

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

    const response = await app.request("/api/v1/web/search", {
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

    const result = await json(app, "/api/v1/web/search", { query: "timeout" });

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

    const result = await json(app, "/api/v1/web/search", { query: "selected" });

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

    const result = await json(app, "/api/v1/web/search", { query: "failure" });

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
        truncated: false,
      })),
    });
    const app = createHttpApp({ ...dependencies(), operations: ops });

    const result = await json(app, "/api/v1/web/fetch", {
      url: "https://example.test",
      render: "browser",
      waitMs: 0,
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({ mode: "tree", truncated: false });
    expect(ops.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.test",
        mode: "auto",
        render: "browser",
        waitMs: 0,
      }),
      expect.any(AbortSignal),
    );
  });

  it("forwards every navigation mode and rejects incompatible section IDs", async () => {
    const ops = operations({
      fetch: vi.fn(async (input) => ({
        url: input.url,
        mode:
          input.section_id !== undefined
            ? "section"
            : input.mode === "tree"
              ? "tree"
              : input.mode === "auto"
                ? "auto"
                : "full",
        content: input.mode === "tree" ? "tree" : "page",
        truncated: false,
      })) as WebOperations["fetch"],
    });
    const app = createHttpApp({ ...dependencies(), operations: ops });

    for (const body of [
      { url: "https://example.test", mode: "auto" },
      { url: "https://example.test", mode: "full" },
      { url: "https://example.test", mode: "tree" },
      {
        url: "https://example.test",
        mode: "auto",
        section_id: "intro",
      },
      { url: "https://example.test", section_id: "intro" },
    ]) {
      const result = await json(app, "/api/v1/web/fetch", body);
      expect(result.response.status).toBe(200);
    }
    expect(ops.fetch).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ mode: "auto", section_id: "intro" }),
      expect.any(AbortSignal),
    );
    expect(ops.fetch).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ mode: "auto", section_id: "intro" }),
      expect.any(AbortSignal),
    );

    for (const body of [
      { url: "https://example.test", mode: "full", section_id: "intro" },
      { url: "https://example.test", mode: "tree", section_id: "intro" },
      { url: "https://example.test", mode: "section" },
      { url: "https://example.test", mode: "invalid" },
      { url: "https://example.test", full: true },
    ]) {
      expect((await json(app, "/api/v1/web/fetch", body)).response.status).toBe(
        400,
      );
    }
    expect(ops.fetch).toHaveBeenCalledTimes(5);
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

    const result = await json(app, "/api/v1/web/links", {
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

  it("delegates default HTTP-service browser rendering to the gateway transport", async () => {
    const transport = vi.fn(async ({ url, waitMs }) => ({
      url: "https://93.184.216.34/final",
      html: `<html><body><article><p>Gateway ${url} waited ${waitMs}.</p></article></body></html>`,
    }));
    const app = createHttpApp({
      credentials: { exaApiKey: "exa-secret" },
      imageMode: true,
      browserGatewayTransport: transport,
    });

    const fetched = await json(app, "/api/v1/web/fetch", {
      url: "https://93.184.216.34/page",
      render: "browser",
      waitMs: 125,
      mode: "full",
    });
    expect(fetched.response.status).toBe(200);
    expect(fetched.body).toEqual({
      url: "https://93.184.216.34/page",
      mode: "full",
      content: "Gateway https://93.184.216.34/page waited 125.\n",
      truncated: false,
    });

    const linked = await json(app, "/api/v1/web/links", {
      url: "https://93.184.216.34/page",
      render: "browser",
      waitMs: 0,
    });
    expect(linked.response.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://93.184.216.34/page",
        waitMs: 0,
      }),
    );
  });

  it("keeps browser rendering explicit when the HTTP-service gateway is absent", async () => {
    const app = createHttpApp({
      credentials: { exaApiKey: "exa-secret" },
      imageMode: true,
    });
    const result = await json(app, "/api/v1/web/fetch", {
      url: "https://93.184.216.34/page",
      render: "browser",
      waitMs: 0,
      mode: "full",
    });
    expect(result.response.status).toBe(502);
    expect(result.body).toEqual({
      code: "render_unavailable",
      message: "fetch requires an explicit capability retry",
    });
  });

  it("keeps supplied direct browser operations for a normal server", async () => {
    const direct = operations({
      fetch: vi.fn(async (input) => ({
        url: input.url,
        mode: "full" as const,
        content: "Direct browser fixture.\n",
        truncated: false,
      })),
    });
    const app = createHttpApp({
      operations: direct,
      credentials: { exaApiKey: "exa-secret" },
      environment: {},
    });
    const result = await json(app, "/api/v1/web/fetch", {
      url: "https://93.184.216.34/page",
      render: "browser",
      waitMs: 0,
      mode: "full",
    });
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({
      url: "https://93.184.216.34/page",
      mode: "full",
      content: "Direct browser fixture.\n",
      truncated: false,
    });
    expect(direct.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://93.184.216.34/page",
        render: "browser",
        waitMs: 0,
      }),
      expect.any(AbortSignal),
    );
  });

  it("rejects invalid search and fetch requests before an operation", async () => {
    const ops = operations();
    const app = createHttpApp({ ...dependencies(), operations: ops });

    expect(
      (await json(app, "/api/v1/web/search", { query: "" })).response.status,
    ).toBe(400);
    expect(
      (
        await json(app, "/api/v1/web/fetch", {
          url: "https://example.test",
          waitMs: 100,
        })
      ).response.status,
    ).toBe(400);
    expect(
      (
        await json(app, "/api/v1/web/links", {
          url: "https://example.test",
          waitMs: 100,
        })
      ).response.status,
    ).toBe(400);
    expect(
      (
        await json(app, "/api/v1/web/fetch", {
          url: "https://example.test",
          mode: "full",
          section_id: "intro",
        })
      ).response.status,
    ).toBe(400);
    expect(
      (
        await json(app, "/api/v1/web/fetch", {
          url: "https://example.test",
          tree: true,
        })
      ).response.status,
    ).toBe(400);
    expect(ops.search).not.toHaveBeenCalled();
    expect(ops.fetch).not.toHaveBeenCalled();
    expect(ops.links).not.toHaveBeenCalled();

    const malformed = await app.request("/api/v1/web/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_request" });
  });

  it.each([
    "/v1/search",
    "/v1/fetch",
    "/v1/links",
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
      "/api/v1/web/fetch",
      "/api/v1/web/links",
      "/api/v1/web/search",
    ]);
    expect(
      (document.components?.schemas as any).SearchResponse.properties.provider
        .enum,
    ).toEqual(["Exa", "DeepSeek", "Kepos Bridge"]);
    const fetchRequest = (document.components?.schemas as any).FetchRequest;
    expect(fetchRequest.properties.mode.enum).toEqual(["auto", "full", "tree"]);
    expect(fetchRequest.properties.mode.default).toBe("auto");
    expect(fetchRequest.properties.full).toBeUndefined();
    const fetchResponse = (document.components?.schemas as any).FetchResponse;
    expect(fetchResponse.properties.mode.enum).toEqual([
      "auto",
      "full",
      "tree",
      "section",
    ]);
    expect(fetchResponse.properties.truncated.type).toBe("boolean");
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
