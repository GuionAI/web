import { describe, expect, it } from "vitest";
import { createWebOperations, type WebOperations } from "@guionai/web-core";

import {
  BRAVE_CREDENTIAL_REF,
  EXA_CREDENTIAL_REF,
  SEARCH_PROVIDER_ID,
} from "../src/contract.js";
import { createGuionSearchProvider } from "../src/provider.js";

function withOperations(overrides: Partial<WebOperations>): WebOperations {
  return { ...createWebOperations(), ...overrides };
}

describe("Guion DSH search provider", () => {
  it("routes each stock PTC query through the live selected provider and resolved credential", async () => {
    let received: unknown;
    const provider = createGuionSearchProvider({
      getProvider: () => "brave",
      credentials: {
        resolve: async (ref) => {
          expect(ref).toBe(BRAVE_CREDENTIAL_REF);
          return { value: "dsh-secret", source: "file" };
        },
      },
      operations: withOperations({
        search: async (input) => {
          received = input;
          return {
            provider: "Brave",
            results: [
              {
                title: "One",
                link: "https://example.test/one",
                snippet: "First",
                position: 1,
              },
            ],
          };
        },
      }),
    });
    const controller = new AbortController();
    const results = await Promise.all(
      ["--flag-like query"].map((query) =>
        provider.search({ query, maxResults: 8 }, controller.signal),
      ),
    );

    expect(provider.id).toBe(SEARCH_PROVIDER_ID);
    expect(provider.available()).toBe(true);
    expect(received).toEqual({
      query: "--flag-like query",
      provider: "brave",
      credentials: { braveApiKey: "dsh-secret" },
      signal: controller.signal,
    });
    expect(results).toEqual([
      {
        sources: [
          { url: "https://example.test/one", title: "One", snippet: "First" },
        ],
        truncated: false,
      },
    ]);
  });

  it("uses one resolved credential per direct core call without process environment fallback or secret leaks", async () => {
    const secret = "exa-secret-never-in-error";
    const provider = createGuionSearchProvider({
      getProvider: () => "exa",
      credentials: {
        resolve: async (ref) => {
          expect(ref).toBe(EXA_CREDENTIAL_REF);
          return { value: secret, source: "file" };
        },
      },
      operations: withOperations({
        search: async () => {
          throw new Error(`transport saw ${secret}`);
        },
      }),
    });

    await expect(provider.search({ query: "failed" })).rejects.toThrow(
      "exa search failed",
    );
    await expect(provider.search({ query: "failed" })).rejects.not.toThrow(
      secret,
    );
  });

  it("rejects malformed core output before returning a DSH result", async () => {
    const provider = createGuionSearchProvider({
      getProvider: () => "exa",
      credentials: {
        resolve: async () => ({ value: "secret", source: "file" }),
      },
      operations: withOperations({
        search: async () => ({
          provider: "Exa",
          results: [{ title: "ok", link: "", snippet: "bad", position: 1 }],
        }),
      }),
    });
    await expect(provider.search({ query: "invalid" })).rejects.toThrow(
      /link must be a non-empty string/,
    );
  });
});
