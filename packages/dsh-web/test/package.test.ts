import { Context } from "@deepseek-ai/cordis";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import { describe, expect, it } from "vitest";
import { createWebOperations, type WebOperations } from "@guionai/web-core";

import {
  SEARCH_PROVIDER_ID,
  type SearchProviderName,
} from "../src/contract.js";
import { createGuionSearchProvider } from "../src/provider.js";
import { apply, SettingsSchema } from "../src/index.js";

function withOperations(overrides: Partial<WebOperations>): WebOperations {
  return { ...createWebOperations(), ...overrides };
}

describe("DSH Web package composition", () => {
  it("resolves the Kepos provider and loopback route defaults", () => {
    expect(SettingsSchema()).toMatchObject({ provider: "exa" });
    expect(
      SettingsSchema({
        provider: "exa",
        keposBridgeEndpoint: "https://bridge.example.test/route",
      }),
    ).toMatchObject({
      provider: "exa",
      keposBridgeEndpoint: "https://bridge.example.test/route",
    });
    expect(() =>
      SettingsSchema({
        provider: "kepos-bridge",
        keposBridgeEndpoint: "https://bridge.example.test/route?bad=true",
      }),
    ).toThrow();
  });
  it("works at the supported alpha.3 WebRuntime provider seam for concurrent PTC queries", async () => {
    const calls: string[] = [];
    const root = new Context();
    await root.plugin(WebRuntime, { searchProvider: SEARCH_PROVIDER_ID });
    await root.plugin({
      inject: ["web"],
      apply(ctx) {
        ctx.web.registerSearchProvider(
          createGuionSearchProvider({
            getProvider: () => "exa",
            getKeposBridgeEndpoint: () => "http://fixture.test/route",
            credentials: {
              resolve: async () => ({ value: "test-secret", source: "file" }),
            },
            operations: withOperations({
              search: async (input) => {
                calls.push(input.query);
                return { provider: "Exa", results: [] };
              },
            }),
          }),
        );
      },
    });
    const controller = new AbortController();
    await expect(
      Promise.all(
        ["first", "second"].map((query) =>
          root.web.search({ query, maxResults: 8 }, controller.signal),
        ),
      ),
    ).resolves.toEqual([
      { sources: [], truncated: false },
      { sources: [], truncated: false },
    ]);
    expect(calls).toEqual(["first", "second"]);
    await root.fiber.dispose();
  });

  it("owns Kepos-only tool registrations and the settings watcher across live transitions", () => {
    let current: {
      provider: SearchProviderName;
      keposBridgeEndpoint: string;
    } = {
      provider: "exa",
      keposBridgeEndpoint: "http://fixture.test/one",
    };
    const watchers = new Set<
      (next: typeof current, prev: typeof current) => void
    >();
    const registered = new Map<string, () => void>();
    let effectDisposer: (() => void) | undefined;
    const ctx = {
      settings: {
        register: () => ({
          get: () => current,
          watch: (
            callback: (next: typeof current, prev: typeof current) => void,
          ) => {
            watchers.add(callback);
            return () => watchers.delete(callback);
          },
        }),
      },
      credentials: { resolve: async () => undefined },
      web: { registerSearchProvider: () => () => undefined },
      tools: {
        register: (definition: { name: string }) => {
          const dispose = () => {
            if (registered.get(definition.name) === dispose)
              registered.delete(definition.name);
          };
          if (registered.has(definition.name))
            throw new Error(`duplicate ${definition.name}`);
          registered.set(definition.name, dispose);
          return dispose;
        },
      },
      effect: (execute: () => () => void) => {
        effectDisposer = execute();
        return effectDisposer;
      },
    };

    apply(ctx as never);
    expect([...registered.keys()]).toEqual([
      "web_fetch",
      "web_links",
      "web_docs",
      "web_source_search",
    ]);
    const transition = (next: typeof current) => {
      const previous = current;
      current = next;
      for (const watch of watchers) watch(next, previous);
    };
    transition({
      provider: "kepos-bridge",
      keposBridgeEndpoint: current.keposBridgeEndpoint,
    });
    expect([...registered.keys()]).toEqual([
      "web_fetch",
      "web_links",
      "web_docs",
      "web_source_search",
      "web_weather",
      "web_sports",
      "web_finance",
      "web_time",
    ]);
    transition({
      provider: "kepos-bridge",
      keposBridgeEndpoint: "https://fixture.test/two",
    });
    expect([...registered.keys()]).toHaveLength(8);
    transition({
      provider: "exa",
      keposBridgeEndpoint: current.keposBridgeEndpoint,
    });
    expect([...registered.keys()]).toEqual([
      "web_fetch",
      "web_links",
      "web_docs",
      "web_source_search",
    ]);
    transition({
      provider: "kepos-bridge",
      keposBridgeEndpoint: current.keposBridgeEndpoint,
    });
    expect([...registered.keys()]).toHaveLength(8);
    effectDisposer?.();
    expect(registered.size).toBe(0);
    expect(watchers.size).toBe(0);
  });
});
