import { Context } from "@deepseek-ai/cordis";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import { describe, expect, it } from "vitest";

import { apply, SettingsSchema } from "../src/index.js";
import { SEARCH_PROVIDER_ID, SETTINGS_NAMESPACE } from "../src/contract.js";
import { createGuionSearchProvider } from "../src/provider.js";

describe("DSH Web package composition", () => {
  it("registers one live provider plus three direct tools without replacing stock PTC search", () => {
    let registered: any;
    let namespace = "";
    let applies = "";
    const tools: any[] = [];
    apply({
      settings: { register: (value: string, schema: unknown, options: any) => {
        namespace = value; applies = options.applies; expect(schema).toBe(SettingsSchema); return { get: () => ({ provider: "brave" }) };
      } },
      credentials: { resolve: async () => undefined },
      web: { registerSearchProvider: (provider: unknown) => { registered = provider; } },
      tools: { register: (tool: unknown) => tools.push(tool) },
    } as any);
    expect(namespace).toBe(SETTINGS_NAMESPACE);
    expect(applies).toBe("live");
    expect(registered.id).toBe(SEARCH_PROVIDER_ID);
    expect(tools.map((tool) => tool.name)).toEqual(["web_fetch", "web_docs", "web_sgraph"]);
  });

  it("works at the supported rc.8 WebRuntime provider seam for concurrent PTC queries", async () => {
    const calls: string[] = [];
    const root = new Context();
    await root.plugin(WebRuntime, { searchProvider: SEARCH_PROVIDER_ID });
    await root.plugin({ inject: ["web"], apply(ctx) {
      ctx.web.registerSearchProvider(createGuionSearchProvider({
        getProvider: () => "exa",
        credentials: { resolve: async () => ({ value: "test-secret", source: "file" }) },
        search: async (input) => { calls.push(input.query); return { provider: "Exa", results: [] }; },
      }));
    } });
    const controller = new AbortController();
    await expect(Promise.all(["first", "second"].map((query) => root.web.search({ query, maxResults: 8 }, controller.signal)))).resolves.toEqual([
      { sources: [], truncated: false }, { sources: [], truncated: false },
    ]);
    expect(calls).toEqual(["first", "second"]);
    await root.fiber.dispose();
  });
});
