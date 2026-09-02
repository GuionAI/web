import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { WebOperations } from "@guionai/web-core";

import {
  webDocsSchema,
  webDocsTool,
  webFetchSchema,
  webFetchTool,
  webLinksSchema,
  webLinksTool,
  webSearchSchema,
  webSearchTool,
  webSgraphSchema,
  webSgraphTool,
} from "../src/tool.js";

function operations(overrides: Partial<WebOperations>): WebOperations {
  const unused = async (): Promise<never> => {
    throw new Error("unused test operation");
  };
  return {
    search: unused,
    fetch: unused,
    links: unused,
    docsResolve: unused,
    docsFetch: unused,
    sgraphSearch: unused,
    keposBridge: unused,
    ...overrides,
  };
}

function call(
  definition: ReturnType<typeof webSearchTool>,
  params: unknown,
  signal?: AbortSignal,
) {
  return definition.execute("call-1", params, signal);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("pi-web extension", () => {
  it("keeps direct closed schemas and validates batch and docs action shapes", async () => {
    for (const schema of [webSearchSchema, webDocsSchema, webSgraphSchema]) {
      expect(schema.type).toBe("object");
      expect(
        (schema as { additionalProperties?: boolean }).additionalProperties,
      ).toBe(false);
    }
    expect(Value.Check(webSearchSchema, { queries: ["x"] })).toBe(true);
    expect(Value.Check(webSearchSchema, { queries: [] })).toBe(false);
    expect(
      Value.Check(webSearchSchema, { queries: ["x", "y", "z", "w", "v"] }),
    ).toBe(false);
    expect(Value.Check(webDocsSchema, { action: "resolve", query: "x" })).toBe(
      true,
    );
    expect(
      Value.Check(webDocsSchema, { action: "fetch", library_id: "/x" }),
    ).toBe(true);

    const search = vi.fn();
    const tool = webSearchTool({ operations: operations({ search }) });
    await expect(
      call(tool, { queries: ["x", "y", "z", "w", "v"] }),
    ).rejects.toThrow(/1 to 4 non-empty strings/);
    await expect(call(tool, { query: "legacy" })).rejects.toThrow(
      /does not accept field query/,
    );
    expect(search).not.toHaveBeenCalled();

    const docs = webDocsTool();
    await expect(
      call(docs, { action: "resolve", query: "x", library_id: "/wrong" }),
    ).rejects.toThrow(/does not accept library_id/);
    await expect(
      call(docs, { action: "fetch", library_id: "/x", query: "wrong" }),
    ).rejects.toThrow(/does not accept query/);
  });

  it("enforces the render/wait and navigation contracts", async () => {
    expect(Value.Check(webFetchSchema, { url: "https://fixture.test" })).toBe(
      true,
    );
    for (const mode of ["auto", "full", "tree"] as const) {
      expect(
        Value.Check(webFetchSchema, {
          url: "https://fixture.test",
          mode,
        }),
      ).toBe(true);
    }
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        section_id: "intro",
      }),
    ).toBe(true);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        mode: "auto",
        section_id: "intro",
      }),
    ).toBe(true);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        render: "http",
      }),
    ).toBe(true);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        render: "browser",
        waitMs: 0,
      }),
    ).toBe(true);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        render: "browser",
        waitMs: 30_000,
      }),
    ).toBe(true);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        render: "browser",
      }),
    ).toBe(false);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        render: "http",
        waitMs: 0,
      }),
    ).toBe(false);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        render: "browser",
        waitMs: 30_001,
      }),
    ).toBe(false);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        mode: "full",
        section_id: "intro",
      }),
    ).toBe(false);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        mode: "tree",
        section_id: "intro",
      }),
    ).toBe(false);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        full: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        mode: "invalid",
      }),
    ).toBe(false);
    expect(
      Value.Check(webFetchSchema, {
        url: "https://fixture.test",
        mode: "section",
      }),
    ).toBe(false);

    const fetch = vi.fn(
      async (input: {
        url: string;
        mode?: string;
        render?: string;
        waitMs?: number;
      }) => ({
        url: input.url,
        mode: "full" as const,
        content: "Rendered Markdown",
        truncated: false,
      }),
    );
    const tool = webFetchTool({ operations: operations({ fetch }) });
    const result = await call(tool, {
      url: "https://fixture.test",
      mode: "full",
      render: "browser",
      waitMs: 1250,
    });
    expect(fetch).toHaveBeenCalledWith(
      {
        url: "https://fixture.test",
        mode: "full",
        render: "browser",
        waitMs: 1250,
      },
      undefined,
    );
    expect(result.content[0]?.text).toBe("Rendered Markdown");
    expect(result.details).toMatchObject({ mode: "full", truncated: false });

    await call(tool, {
      url: "https://fixture.test",
      section_id: "intro",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      { url: "https://fixture.test", section_id: "intro" },
      undefined,
    );
    await call(tool, {
      url: "https://fixture.test",
      mode: "auto",
      section_id: "intro",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      { url: "https://fixture.test", mode: "auto", section_id: "intro" },
      undefined,
    );

    await expect(
      call(tool, {
        url: "https://fixture.test",
        render: "browser",
      }),
    ).rejects.toThrow("waitMs is required");
    await expect(
      call(tool, {
        url: "https://fixture.test",
        render: "http",
        waitMs: 0,
      }),
    ).rejects.toThrow("waitMs is only valid");
    await expect(
      call(tool, { url: "https://fixture.test", mode: "section" }),
    ).rejects.toThrow(/mode.*auto.*full.*tree/);
    expect(fetch).toHaveBeenCalledTimes(3);

    expect(Value.Check(webLinksSchema, { url: "https://fixture.test" })).toBe(
      true,
    );
    expect(
      Value.Check(webLinksSchema, {
        url: "https://fixture.test",
        render: "browser",
        waitMs: 0,
        limit: 25,
      }),
    ).toBe(true);
    expect(
      Value.Check(webLinksSchema, {
        url: "https://fixture.test",
        render: "browser",
      }),
    ).toBe(false);
    expect(
      Value.Check(webLinksSchema, {
        url: "https://fixture.test",
        limit: 101,
      }),
    ).toBe(false);

    const links = vi.fn(async (input: { url: string }) => ({
      url: input.url,
      links: [{ text: "Rendered link", url: "https://fixture.test/link" }],
      truncated: false,
    }));
    const linksTool = webLinksTool({ operations: operations({ links }) });
    const linksResult = await call(linksTool, {
      url: "https://fixture.test",
      limit: 25,
      render: "browser",
      waitMs: 1250,
    });
    expect(links).toHaveBeenCalledWith(
      {
        url: "https://fixture.test",
        limit: 25,
        render: "browser",
        waitMs: 1250,
      },
      undefined,
    );
    expect(linksResult.content[0]?.text).toContain("Rendered link");
  });

  it("preserves structured fetch failures for Pi callers", async () => {
    const failure = Object.assign(
      new Error("javascript rendering may be required"),
      {
        code: "javascript_rendering_may_be_required",
        details: {
          retryableWithRender: true,
          suggestedArguments: { render: "browser", waitMs: 2000 },
        },
      },
    );
    const tool = webFetchTool({
      operations: operations({
        fetch: async () => {
          throw failure;
        },
      }),
    });
    await expect(call(tool, { url: "https://fixture.test" })).rejects.toBe(
      failure,
    );

    const blocked = Object.assign(new Error("render domain not allowed"), {
      code: "render_domain_not_allowed",
      details: {
        retryable: false,
        reportUrl: "https://github.com/guionai/web/issues/new",
        blockedHostname: "cdn.fixture.test",
      },
    });
    const blockedTool = webFetchTool({
      operations: operations({
        fetch: async () => {
          throw blocked;
        },
      }),
    });
    await expect(
      call(blockedTool, {
        url: "https://fixture.test",
        render: "browser",
        waitMs: 0,
      }),
    ).rejects.toBe(blocked);
  });

  it("starts searches concurrently, merges successes deterministically, and reports partial failures", async () => {
    const first = deferred<{
      provider: "Brave";
      results: Array<{
        title: string;
        link: string;
        snippet: string;
        position: number;
      }>;
    }>();
    const second = deferred<{
      provider: "Brave";
      results: Array<{
        title: string;
        link: string;
        snippet: string;
        position: number;
      }>;
    }>();
    const third = deferred<{
      provider: "Brave";
      results: Array<{
        title: string;
        link: string;
        snippet: string;
        position: number;
      }>;
    }>();
    const pending = [first, second, third];
    let nextSearch = 0;
    const search = vi.fn(
      (input: { query: string }) => pending[nextSearch++]!.promise,
    );
    const resultPromise = call(
      webSearchTool({ operations: operations({ search }) }),
      {
        queries: ["slow", "fast", "broken", "slow"],
      },
    );

    expect(search.mock.calls.map(([input]) => input.query)).toEqual([
      "slow",
      "fast",
      "broken",
    ]);
    second.resolve({
      provider: "Brave",
      results: [
        { title: "B1", link: "https://b/1", snippet: "b", position: 1 },
      ],
    });
    third.reject(new Error("fixture unavailable"));
    first.resolve({
      provider: "Brave",
      results: [
        { title: "A1", link: "https://a/1", snippet: "a", position: 1 },
        { title: "A2", link: "https://a/2", snippet: "a", position: 2 },
      ],
    });

    const result = await resultPromise;
    const details = result.details as {
      provider: string;
      results: Array<{ title: string; position: number }>;
      errors: Array<{ query: string; error: string }>;
    };
    expect(details.provider).toBe("Brave");
    expect(
      details.results.map(({ title, position }) => ({ title, position })),
    ).toEqual([
      { title: "A1", position: 1 },
      { title: "B1", position: 2 },
      { title: "A2", position: 3 },
    ]);
    expect(details.errors).toEqual([
      { query: "broken", error: "fixture unavailable" },
    ]);
    expect(result.content[0]?.text).toContain(
      'Search failures:\n- "broken": fixture unavailable',
    );
  });

  it("pins an explicitly configured Kepos provider for every search", async () => {
    const search = vi.fn(async () => ({
      provider: "Kepos Bridge" as const,
      results: [],
    }));
    const tool = webSearchTool({
      operations: operations({ search }),
      provider: "kepos-bridge",
    });

    await call(tool, { queries: ["one", "two"] });

    expect(search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: "kepos-bridge", query: "one" }),
    );
    expect(search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: "kepos-bridge", query: "two" }),
    );
  });

  it("forwards explicit DeepSeek selection for every batched query", async () => {
    const search = vi.fn(async () => ({
      provider: "DeepSeek" as const,
      results: [],
    }));
    const tool = webSearchTool({
      operations: operations({ search }),
      provider: "deepseek",
      credentials: () => ({ deepseekApiKey: "deepseek-secret" }),
    });

    await call(tool, { queries: ["one", "two"] });

    expect(search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: "deepseek",
        query: "one",
        credentials: { deepseekApiKey: "deepseek-secret" },
      }),
    );
    expect(search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: "deepseek",
        query: "two",
        credentials: { deepseekApiKey: "deepseek-secret" },
      }),
    );
  });

  it("delegates every capability in-process and propagates caller cancellation", async () => {
    const abortable = <T>(signal: AbortSignal | undefined) =>
      new Promise<T>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("Operation aborted")),
          { once: true },
        );
      });
    const definitions: Array<[ReturnType<typeof webSearchTool>, unknown]> = [
      [
        webSearchTool({
          operations: operations({
            search: ({ signal }) => abortable(signal),
          }),
        }),
        { queries: ["wait"] },
      ],
      [
        webFetchTool({
          operations: operations({
            fetch: (_input, signal) => abortable(signal),
          }),
        }),
        { url: "https://fixture.test" },
      ],
      [
        webLinksTool({
          operations: operations({
            links: (_input, signal) => abortable(signal),
          }),
        }),
        { url: "https://fixture.test" },
      ],
      [
        webDocsTool({
          operations: operations({
            docsResolve: ({ signal }) => abortable(signal),
          }),
        }),
        { action: "resolve", query: "fixture" },
      ],
      [
        webDocsTool({
          operations: operations({
            docsFetch: ({ signal }) => abortable(signal),
          }),
        }),
        { action: "fetch", library_id: "/fixture" },
      ],
      [
        webSgraphTool({
          operations: operations({
            sgraphSearch: ({ signal }) => abortable(signal),
          }),
        }),
        { query: "fixture" },
      ],
    ];

    for (const [definition, params] of definitions) {
      const controller = new AbortController();
      const pending = call(definition, params, controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow("Operation aborted");
    }
  });

  it("preserves structured details and bounded model-facing fetch content", async () => {
    const content = Array.from(
      { length: 3000 },
      (_, index) => `line ${index}`,
    ).join("\n");
    const tool = webFetchTool({
      operations: operations({
        fetch: async () => ({
          url: "https://fixture.test",
          mode: "full",
          content,
          truncated: false,
        }),
      }),
    });
    const result = await call(tool, { url: "https://fixture.test" });
    const details = result.details as {
      url: string;
      content: string;
      fullOutputPath: string;
      truncation: { truncated: boolean };
    };
    try {
      expect(details.url).toBe("https://fixture.test");
      expect(details.truncation.truncated).toBe(true);
      expect(result.content[0]?.text).toContain(
        'Use web_fetch with mode: "full" for the complete document, or section_id with omitted/auto mode to navigate to a section.',
      );
      expect(await readFile(details.fullOutputPath, "utf8")).toBe(content);
    } finally {
      await rm(dirname(details.fullOutputPath), {
        recursive: true,
        force: true,
      });
    }
  });
});
