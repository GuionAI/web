import { describe, expect, it } from "vitest";

import { formatSearchResults, search, selectProvider } from "../src/index.js";

const exaFixture = {
  results: [
    {
      title: "Go Generics Guide",
      url: "https://go.dev/generics",
      highlights: ["A comprehensive guide to generics in Go.", "ignored"],
    },
    {
      title: "Fallback",
      url: "https://example.test/fallback",
      publishedDate: "2024-01-15",
      author: "Jane Doe",
    },
  ],
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("search providers migrated from Organon fixtures", () => {
  it("sends the Exa request shape and maps its first highlight", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const result = await search({
      query: "golang generics",
      credentials: { exaApiKey: "test-exa-key" },
      endpoints: { exa: "http://fixture.test" },
      fetch: async (receivedURL, receivedInit) => {
        url = String(receivedURL);
        init = receivedInit;
        return response(exaFixture);
      },
    });

    expect(url).toBe("http://fixture.test/search");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("test-exa-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "golang generics",
      numResults: 10,
      contents: { highlights: true },
    });
    expect(result).toEqual({
      provider: "Exa",
      results: [
        {
          title: "Go Generics Guide",
          link: "https://go.dev/generics",
          snippet: "A comprehensive guide to generics in Go.",
          position: 1,
        },
        {
          title: "Fallback",
          link: "https://example.test/fallback",
          snippet: "2024-01-15 by Jane Doe",
          position: 2,
        },
      ],
    });
  });

  it("sends Brave authentication and maps no more than ten ranked results", async () => {
    let url = "";
    let headers: Headers | undefined;
    const result = await search({
      query: "tree sitter",
      credentials: { braveApiKey: "test-brave-key" },
      endpoints: { brave: "http://fixture.test/res/v1" },
      fetch: async (receivedURL, init) => {
        url = String(receivedURL);
        headers = new Headers(init?.headers);
        return response({
          web: {
            results: Array.from({ length: 11 }, (_, index) => ({
              title: `Result ${index + 1}`,
              url: `https://example.test/${index + 1}`,
              description: "fixture",
            })),
          },
        });
      },
    });

    expect(url).toBe(
      "http://fixture.test/res/v1/web/search?q=tree%20sitter&count=10",
    );
    expect(headers?.get("X-Subscription-Token")).toBe("test-brave-key");
    expect(result.provider).toBe("Brave");
    expect(result.results).toHaveLength(10);
    expect(result.results[9]).toMatchObject({
      title: "Result 10",
      position: 10,
    });
  });

  it("preserves explicit provider, fallback, and empty-key behavior", () => {
    expect(
      selectProvider(undefined, { exaApiKey: "exa", braveApiKey: "brave" }),
    ).toBe("exa");
    expect(selectProvider(undefined, { braveApiKey: "brave" })).toBe("brave");
    expect(
      selectProvider("brave", { exaApiKey: "exa", braveApiKey: "brave" }),
    ).toBe("brave");
    expect(() => selectProvider("duckduckgo", { exaApiKey: "key" })).toThrow(
      'unsupported search provider "duckduckgo"',
    );
    expect(() => selectProvider("exa", {})).toThrow(
      "EXA_API_KEY is required when --provider exa is selected",
    );
    expect(() =>
      selectProvider(undefined, { exaApiKey: "", braveApiKey: "brave" }),
    ).toThrow("EXA_API_KEY is set but empty");
    expect(() => selectProvider(undefined, {})).toThrow(
      "web search requires EXA_API_KEY or BRAVE_API_KEY",
    );
  });

  it("does not expose remote error bodies or credentials", async () => {
    await expect(
      search({
        query: "secret query",
        credentials: { exaApiKey: "very-secret-key" },
        fetch: async () =>
          new Response("very-secret-key remote diagnostic", { status: 401 }),
      }),
    ).rejects.toThrow("exa search: HTTP 401");
    await expect(
      search({
        query: "secret query",
        credentials: { exaApiKey: "very-secret-key" },
        fetch: async () =>
          new Response("very-secret-key remote diagnostic", { status: 401 }),
      }),
    ).rejects.not.toThrow("very-secret-key");
  });

  it("formats the established human-readable result contract", () => {
    expect(formatSearchResults([])).toBe(
      "No results found. Try rephrasing your search.\n",
    );
    expect(
      formatSearchResults([
        {
          title: "Go Blog",
          link: "https://go.dev/blog",
          snippet: "The Go programming language blog.",
          position: 1,
        },
      ]),
    ).toContain(
      "1. Go Blog\n   URL: https://go.dev/blog\n   Summary: The Go programming language blog.",
    );
  });
});
