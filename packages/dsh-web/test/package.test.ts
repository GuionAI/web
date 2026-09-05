import { describe, expect, it } from "vitest";

import {
  DEFAULT_KEPOS_BRIDGE_ENDPOINT,
  type SearchProviderName,
} from "../src/contract.js";
import { apply, inject, SettingsSchema } from "../src/index.js";

describe("DSH Web package composition", () => {
  it("keeps the live provider settings contract", () => {
    expect(SettingsSchema()).toMatchObject({
      provider: "exa",
      keposBridgeEndpoint: DEFAULT_KEPOS_BRIDGE_ENDPOINT,
    });
    expect(
      SettingsSchema({
        provider: "kepos-bridge",
        keposBridgeEndpoint: "https://bridge.example.test/route",
      }),
    ).toMatchObject({
      provider: "kepos-bridge",
      keposBridgeEndpoint: "https://bridge.example.test/route",
    });
    expect(() =>
      SettingsSchema({
        provider: "kepos-bridge",
        keposBridgeEndpoint: "https://bridge.example.test/route?bad=true",
      }),
    ).toThrow();
  });

  it("registers the complete Guion suite without an official Web service", () => {
    let current: {
      provider: SearchProviderName;
      keposBridgeEndpoint: string;
    } = {
      provider: "exa",
      keposBridgeEndpoint: "http://fixture.test/one",
    };
    const watchers = new Set<
      (next: typeof current, previous: typeof current) => void
    >();
    const registered = new Map<string, () => void>();
    let effectDisposer: (() => void) | undefined;
    const ctx = {
      settings: {
        register: () => ({
          get: () => current,
          watch: (
            callback: (next: typeof current, previous: typeof current) => void,
          ) => {
            watchers.add(callback);
            return () => watchers.delete(callback);
          },
        }),
      },
      credentials: { resolve: async () => undefined },
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

    expect(inject).toEqual(["credentials", "settings", "tools"]);
    apply(ctx as never);
    expect([...registered.keys()]).toEqual([
      "web_search",
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
      "web_search",
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
      provider: "exa",
      keposBridgeEndpoint: current.keposBridgeEndpoint,
    });
    expect([...registered.keys()]).toEqual([
      "web_search",
      "web_fetch",
      "web_links",
      "web_docs",
      "web_source_search",
    ]);
    effectDisposer?.();
    expect(registered.size).toBe(0);
    expect(watchers.size).toBe(0);
  });
});
