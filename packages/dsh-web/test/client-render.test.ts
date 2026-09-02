import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

let stateCall = 0;
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: <T>(initial: T) => {
      stateCall += 1;
      return [stateCall === 9 ? true : initial, () => undefined] as const;
    },
  };
});

import { apply } from "../src/client.js";

const require = createRequire(import.meta.url);
const renderToStaticMarkup = require("react-dom/server")
  .renderToStaticMarkup as (element: unknown) => string;

describe("DSH settings client rendered contract", () => {
  it("associates the bridge endpoint help text with its input", () => {
    const previousDocument = (globalThis as any).document;
    const settings = {
      getSnapshot: () => ({
        status: "ready" as const,
        writable: true,
        value: {
          provider: "kepos-bridge" as const,
          keposBridgeEndpoint: "https://bridge.example.test/route",
        },
      }),
      subscribe: () => () => undefined,
      set: async () => undefined,
    };
    const credentials = {
      describe: async () => ({ ok: true as const, value: {} }),
      set: async () => ({ ok: true as const, value: undefined }),
      unset: async () => ({ ok: true as const, value: undefined }),
    };
    let settingsComponent: (() => unknown) | undefined;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: () => ({ dataset: {}, set textContent(_: string) {} }),
        head: { append: () => undefined },
      },
    });
    try {
      apply({
        effect: (execute: () => () => void) => execute(),
        remote: { credentials, $on: () => () => undefined },
        settingsScope: { bind: () => settings },
        slots: {
          inject: (_name: string, callback: () => unknown) => callback(),
          register: (spec: { name: string }, component: unknown) => {
            if (spec.name === "settings.plugin.item")
              settingsComponent = component as () => unknown;
            return () => undefined;
          },
        },
      } as never);
      if (settingsComponent === undefined)
        throw new Error("settings component was not registered");
      const html = renderToStaticMarkup(settingsComponent());
      const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
      expect(describedBy).toMatch(/-bridge-endpoint-help$/);
      expect(html).toContain(`id="${describedBy}"`);
      expect(html).toContain('value="kepos-bridge"');
      expect(html).toContain('value="https://bridge.example.test/route"');
      expect(html).toContain("DeepSeek API key");
      expect(html).not.toContain("DeepSeek endpoint");
    } finally {
      if (previousDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = previousDocument;
    }
  });
});
