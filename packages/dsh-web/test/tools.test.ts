import { describe, expect, it, vi } from "vitest";

import { CONTEXT7_CREDENTIAL_REF } from "../src/contract.js";
import { createWebToolDefinitions, registerWebTools, type WebToolDependencies } from "../src/tools.js";

const signal = () => new AbortController().signal;
type ToolDefinition = ReturnType<typeof createWebToolDefinitions>[number];
function call(definition: ToolDefinition, args: unknown, abortSignal = signal()): Promise<unknown> {
  return definition.execute(args, { signal: abortSignal } as never);
}
function dependencies(overrides: Partial<WebToolDependencies> = {}): WebToolDependencies {
  return { credentials: { resolve: async () => undefined }, ...overrides };
}

describe("DSH direct web tools", () => {
  it("registers direct fetch, docs, and Sourcegraph tools with current schemas and concurrent execution", () => {
    const definitions = createWebToolDefinitions(dependencies());
    const registered: ToolDefinition[] = [];
    registerWebTools({ tools: { register: (definition: ToolDefinition) => registered.push(definition) } } as never, dependencies());
    expect(definitions.map((definition) => definition.name)).toEqual(["web_fetch", "web_docs", "web_sgraph"]);
    expect(registered.map((definition) => definition.name)).toEqual(["web_fetch", "web_docs", "web_sgraph"]);
    expect([
      definitions[0]!.isConcurrencySafe?.({ url: "https://example.test" }),
      definitions[1]!.isConcurrencySafe?.({ action: "resolve", query: "react" }),
      definitions[2]!.isConcurrencySafe?.({ query: "repo:guionai" }),
    ]).toEqual([true, true, true]);
    expect((definitions[0]!.parameters as any).additionalProperties).toBe(false);
    expect((definitions[1]!.parameters as any).properties.action.enum).toEqual(["resolve", "fetch"]);
    expect(Object.keys((definitions[2]!.parameters as any).properties)).toEqual(["query", "count", "context", "timeout"]);
  });

  it("calls the bundled operations once with current direct inputs and caller cancellation", async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const [fetch, docs, sgraph] = createWebToolDefinitions(dependencies({
      fetch: async (input, abortSignal) => { calls.push({ kind: "fetch", input, abortSignal }); return { url: input.url, mode: "section", content: "selected" }; },
      docsResolve: async (input) => { calls.push({ kind: "resolve", input }); return { query: input.query, libraries: [] }; },
      docsFetch: async (input) => { calls.push({ kind: "docs", input }); return { library_id: input.library_id, topic: input.topic, content: "documentation" }; },
      sgraphSearch: async (input) => { calls.push({ kind: "sgraph", input }); return { content: "# results" }; },
    }));

    await expect(call(fetch!, { url: "https://example.test", section_id: "install" }, controller.signal)).resolves.toMatchObject({ mode: "section" });
    await expect(call(docs!, { action: "resolve", query: "react" }, controller.signal)).resolves.toMatchObject({ query: "react" });
    await expect(call(docs!, { action: "fetch", library_id: "/react", topic: "hooks", tokens: 500 }, controller.signal)).resolves.toMatchObject({ content: "documentation" });
    await expect(call(sgraph!, { query: "repo:guionai", count: 14, context: 3, timeout: 9 }, controller.signal)).resolves.toMatchObject({ content: "# results" });
    expect(calls).toEqual([
      { kind: "fetch", input: { url: "https://example.test", tree: undefined, section_id: "install", full: undefined, tree_threshold: undefined }, abortSignal: controller.signal },
      { kind: "resolve", input: { query: "react", credentials: {}, signal: controller.signal } },
      { kind: "docs", input: { action: "fetch", library_id: "/react", topic: "hooks", tokens: 500, credentials: {}, signal: controller.signal } },
      { kind: "sgraph", input: { query: "repo:guionai", count: 14, context: 3, timeout: 9, signal: controller.signal } },
    ]);
  });

  it("passes a namespaced Context7 secret only to each docs core call and keeps errors secret-free", async () => {
    const secret = "ctx7-secret-never-in-error";
    const docs = createWebToolDefinitions(dependencies({
      credentials: { resolve: async (ref) => {
        expect(ref).toBe(CONTEXT7_CREDENTIAL_REF);
        return { value: secret, source: "file" };
      } },
      docsFetch: async (input) => {
        expect(input.credentials).toEqual({ context7ApiKey: secret });
        throw new Error(secret);
      },
    }))[1]!;
    await expect(call(docs, { action: "fetch", library_id: "/react" })).rejects.toThrow("web docs fetch failed");
    await expect(call(docs, { action: "fetch", library_id: "/react" })).rejects.not.toThrow(secret);
  });

  it("rejects undeclared and cross-action fields before invoking operations", async () => {
    const fetch = vi.fn();
    const docsResolve = vi.fn();
    const [fetchTool, docsTool, sgraphTool] = createWebToolDefinitions(dependencies({ fetch, docsResolve }));
    await expect(call(fetchTool!, { url: "https://example.test", extra: true })).rejects.toThrow(/does not accept field extra/);
    await expect(call(docsTool!, { action: "resolve", query: "x", library_id: "/wrong" })).rejects.toThrow(/does not accept library_id/);
    await expect(call(sgraphTool!, { query: "x", extra: true })).rejects.toThrow(/does not accept field extra/);
    expect(fetch).not.toHaveBeenCalled();
    expect(docsResolve).not.toHaveBeenCalled();
  });
});
