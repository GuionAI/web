import { Context } from "@deepseek-ai/cordis";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import { describe, expect, it } from "vitest";
import { createWebOperations, type WebOperations } from "@guionai/web-core";

import { SEARCH_PROVIDER_ID } from "../src/contract.js";
import { createGuionSearchProvider } from "../src/provider.js";

function withOperations(overrides: Partial<WebOperations>): WebOperations {
  return { ...createWebOperations(), ...overrides };
}

describe("DSH Web package composition", () => {
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
});
