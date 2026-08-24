import { describe, expect, it, vi } from "vitest";
import {
  createWebOperations,
  FetchCapabilityError,
  type WebOperations,
} from "@guionai/web-core";

import { CONTEXT7_CREDENTIAL_REF } from "../src/contract.js";
import {
  createWebToolDefinitions,
  registerWebTools,
  type WebToolDependencies,
} from "../src/tools.js";

const signal = () => new AbortController().signal;
type ToolDefinition = ReturnType<typeof createWebToolDefinitions>[number];
function call(
  definition: ToolDefinition,
  args: unknown,
  abortSignal = signal(),
): Promise<unknown> {
  return definition.execute(args, { signal: abortSignal } as never);
}
function operations(overrides: Partial<WebOperations>): WebOperations {
  return { ...createWebOperations(), ...overrides };
}

function dependencies(
  overrides: Partial<WebToolDependencies> = {},
): WebToolDependencies {
  return { credentials: { resolve: async () => undefined }, ...overrides };
}

describe("DSH direct web tools", () => {
  it("registers fetch, links, docs, and Sourcegraph tools with current schemas and concurrent execution", () => {
    const definitions = createWebToolDefinitions(dependencies());
    const registered: ToolDefinition[] = [];
    registerWebTools(
      {
        tools: {
          register: (definition: ToolDefinition) => registered.push(definition),
        },
      } as never,
      dependencies(),
    );
    expect(definitions.map((definition) => definition.name)).toEqual([
      "web_fetch",
      "web_links",
      "web_docs",
      "web_source_search",
    ]);
    expect(registered.map((definition) => definition.name)).toEqual([
      "web_fetch",
      "web_links",
      "web_docs",
      "web_source_search",
    ]);
    expect([
      definitions[0]!.isConcurrencySafe?.({ url: "https://example.test" }),
      definitions[1]!.isConcurrencySafe?.({
        url: "https://example.test",
        render: "agent-browser",
        waitMs: 0,
      }),
      definitions[2]!.isConcurrencySafe?.({
        action: "resolve",
        query: "react",
      }),
      definitions[3]!.isConcurrencySafe?.({ query: "repo:guionai" }),
    ]).toEqual([true, true, true, true]);
    expect((definitions[0]!.parameters as any).additionalProperties).toBe(
      false,
    );
    expect((definitions[0]!.parameters as any).properties.render.enum).toEqual([
      "fetch",
      "agent-browser",
    ]);
    expect((definitions[0]!.parameters as any).properties.waitMs.type).toBe(
      "integer",
    );
    expect((definitions[1]!.parameters as any).properties.limit.default).toBe(
      100,
    );
    expect((definitions[1]!.parameters as any).properties.render.enum).toEqual([
      "fetch",
      "agent-browser",
    ]);
    expect((definitions[2]!.parameters as any).properties.action.enum).toEqual([
      "resolve",
      "fetch",
    ]);
    expect(Object.keys((definitions[3]!.parameters as any).properties)).toEqual(
      ["query", "count", "context", "timeout"],
    );
  });

  it("calls the bundled operations once with current direct inputs and caller cancellation", async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const [fetch, links, docs, sgraph] = createWebToolDefinitions(
      dependencies({
        operations: operations({
          fetch: async (input, abortSignal) => {
            calls.push({ kind: "fetch", input, abortSignal });
            return { url: input.url, mode: "section", content: "selected" };
          },
          links: async (input, abortSignal) => {
            calls.push({ kind: "links", input, abortSignal });
            return {
              url: input.url,
              links: [{ text: "destination", url: "https://example.test/to" }],
              truncated: false,
            };
          },
          docsResolve: async (input) => {
            calls.push({ kind: "resolve", input });
            return { query: input.query, libraries: [] };
          },
          docsFetch: async (input) => {
            calls.push({ kind: "docs", input });
            return {
              library_id: input.library_id,
              topic: input.topic,
              content: "documentation",
            };
          },
          sgraphSearch: async (input) => {
            calls.push({ kind: "sgraph", input });
            return { content: "# results" };
          },
        }),
      }),
    );

    await expect(
      call(
        fetch!,
        {
          url: "https://example.test",
          section_id: "install",
          render: "agent-browser",
          waitMs: 2000,
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({ mode: "section" });
    await expect(
      call(
        links!,
        {
          url: "https://example.test",
          limit: 25,
          render: "agent-browser",
          waitMs: 2000,
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({
      links: [{ url: "https://example.test/to" }],
    });
    await expect(
      call(docs!, { action: "resolve", query: "react" }, controller.signal),
    ).resolves.toMatchObject({ query: "react" });
    await expect(
      call(
        docs!,
        { action: "fetch", library_id: "/react", topic: "hooks", tokens: 500 },
        controller.signal,
      ),
    ).resolves.toMatchObject({ content: "documentation" });
    await expect(
      call(
        sgraph!,
        { query: "repo:guionai", count: 14, context: 3, timeout: 9 },
        controller.signal,
      ),
    ).resolves.toMatchObject({ content: "# results" });
    expect(calls).toEqual([
      {
        kind: "fetch",
        input: {
          url: "https://example.test",
          tree: undefined,
          section_id: "install",
          full: undefined,
          tree_threshold: undefined,
          render: "agent-browser",
          waitMs: 2000,
        },
        abortSignal: controller.signal,
      },
      {
        kind: "links",
        input: {
          url: "https://example.test",
          limit: 25,
          render: "agent-browser",
          waitMs: 2000,
        },
        abortSignal: controller.signal,
      },
      {
        kind: "resolve",
        input: { query: "react", credentials: {}, signal: controller.signal },
      },
      {
        kind: "docs",
        input: {
          action: "fetch",
          library_id: "/react",
          topic: "hooks",
          tokens: 500,
          credentials: {},
          signal: controller.signal,
        },
      },
      {
        kind: "sgraph",
        input: {
          query: "repo:guionai",
          count: 14,
          context: 3,
          timeout: 9,
          signal: controller.signal,
        },
      },
    ]);
  });

  it("preserves shared fetch validation, cancellation, and structured renderer failures", async () => {
    const fetch = createWebToolDefinitions(dependencies())[0]!;
    await expect(
      call(fetch, {
        url: "https://example.test",
        render: "agent-browser",
      }),
    ).rejects.toThrow("waitMs is required");
    await expect(
      call(fetch, {
        url: "https://example.test",
        waitMs: 0,
      }),
    ).rejects.toThrow("waitMs is only valid");
    await expect(
      call(fetch, {
        url: "https://example.test",
        render: "agent-browser",
        waitMs: 30_001,
      }),
    ).rejects.toThrow("waitMs must be an integer");

    const retry = new FetchCapabilityError(
      "javascript_rendering_may_be_required",
      {
        retryableWithRender: true,
        suggestedArguments: { render: "agent-browser", waitMs: 2000 },
      },
    );
    const allowlist = new FetchCapabilityError("render_domain_not_allowed", {
      retryable: false,
      reportUrl: "https://github.com/guionai/web/issues/new",
      blockedHostname: "api.example.test",
    });
    const controller = new AbortController();
    let aborted = false;
    const cancel = createWebToolDefinitions(
      dependencies({
        operations: operations({
          fetch: async (_input, signal) =>
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new Error("Operation aborted"));
                },
                { once: true },
              );
            }),
        }),
      }),
    )[0]!;
    const pending = call(
      cancel,
      { url: "https://example.test", render: "fetch" },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("Operation aborted");
    expect(aborted).toBe(true);

    const retryDefinition = createWebToolDefinitions(
      dependencies({
        operations: operations({
          fetch: async () => {
            throw retry;
          },
        }),
      }),
    )[0]!;
    await expect(
      call(retryDefinition, {
        url: "https://example.test",
        render: "fetch",
      }),
    ).rejects.toMatchObject({
      code: "javascript_rendering_may_be_required",
      details: {
        retryableWithRender: true,
        suggestedArguments: { render: "agent-browser", waitMs: 2000 },
      },
    });

    const allowlistDefinition = createWebToolDefinitions(
      dependencies({
        operations: operations({
          fetch: async () => {
            throw allowlist;
          },
        }),
      }),
    )[0]!;
    await expect(
      call(allowlistDefinition, {
        url: "https://example.test",
        render: "agent-browser",
        waitMs: 0,
      }),
    ).rejects.toMatchObject({
      code: "render_domain_not_allowed",
      details: {
        retryable: false,
        reportUrl: "https://github.com/guionai/web/issues/new",
        blockedHostname: "api.example.test",
      },
    });
  });

  it("passes a namespaced Context7 secret only to each docs core call and keeps errors secret-free", async () => {
    const secret = "ctx7-secret-never-in-error";
    const docs = createWebToolDefinitions(
      dependencies({
        credentials: {
          resolve: async (ref) => {
            expect(ref).toBe(CONTEXT7_CREDENTIAL_REF);
            return { value: secret, source: "file" };
          },
        },
        operations: operations({
          docsFetch: async (input) => {
            expect(input.credentials).toEqual({ context7ApiKey: secret });
            throw new Error(secret);
          },
        }),
      }),
    )[2]!;
    await expect(
      call(docs, { action: "fetch", library_id: "/react" }),
    ).rejects.toThrow("web docs fetch failed");
    await expect(
      call(docs, { action: "fetch", library_id: "/react" }),
    ).rejects.not.toThrow(secret);
  });

  it("rejects undeclared and cross-action fields before invoking operations", async () => {
    const fetch = vi.fn();
    const links = vi.fn();
    const docsResolve = vi.fn();
    const [fetchTool, linksTool, docsTool, sgraphTool] =
      createWebToolDefinitions(
        dependencies({ operations: operations({ fetch, links, docsResolve }) }),
      );
    await expect(
      call(fetchTool!, { url: "https://example.test", extra: true }),
    ).rejects.toThrow(/does not accept field extra/);
    await expect(
      call(linksTool!, { url: "https://example.test", extra: true }),
    ).rejects.toThrow(/does not accept field extra/);
    await expect(
      call(linksTool!, { url: "https://example.test", limit: 0 }),
    ).rejects.toThrow("limit must be an integer from 1 through 100");
    await expect(
      call(linksTool!, { url: "https://example.test", limit: 101 }),
    ).rejects.toThrow("limit must be an integer from 1 through 100");
    await expect(
      call(linksTool!, {
        url: "https://example.test",
        render: "agent-browser",
      }),
    ).rejects.toThrow("waitMs is required");
    await expect(
      call(linksTool!, {
        url: "https://example.test",
        render: "agent-browser",
        waitMs: -1,
      }),
    ).rejects.toThrow("waitMs must be an integer from 0 through 30000");
    await expect(
      call(docsTool!, { action: "resolve", query: "x", library_id: "/wrong" }),
    ).rejects.toThrow(/does not accept library_id/);
    await expect(
      call(sgraphTool!, { query: "x", extra: true }),
    ).rejects.toThrow(/does not accept field extra/);
    expect(fetch).not.toHaveBeenCalled();
    expect(links).not.toHaveBeenCalled();
    expect(docsResolve).not.toHaveBeenCalled();
  });
});
