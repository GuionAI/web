import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";

import {
  webDocsSchema,
  webDocsTool,
  webFetchTool,
  webSearchSchema,
  webSearchTool,
  webSgraphSchema,
  webSgraphTool,
} from "../src/tool.js";

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
    const tool = webSearchTool({ search });
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
    const resultPromise = call(webSearchTool({ search }), {
      queries: ["slow", "fast", "broken", "slow"],
    });

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
        webSearchTool({ search: ({ signal }) => abortable(signal) }),
        { queries: ["wait"] },
      ],
      [
        webFetchTool({ fetch: (_input, signal) => abortable(signal) }),
        { url: "https://fixture.test" },
      ],
      [
        webDocsTool({ docsResolve: ({ signal }) => abortable(signal) }),
        { action: "resolve", query: "fixture" },
      ],
      [
        webDocsTool({ docsFetch: ({ signal }) => abortable(signal) }),
        { action: "fetch", library_id: "/fixture" },
      ],
      [
        webSgraphTool({ sgraphSearch: ({ signal }) => abortable(signal) }),
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
      fetch: async () => ({
        url: "https://fixture.test",
        mode: "full",
        content,
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
        "Use web_fetch with tree or section_id to navigate the document.",
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
