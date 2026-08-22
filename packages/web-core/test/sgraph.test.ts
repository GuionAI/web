import { describe, expect, it } from "vitest";

import { formatSourcegraphResults, sgraphSearch } from "../src/index.js";

const GRAPHQL_QUERY = "query Search($query: String!) { " +
  "search(query: $query, version: V2, patternType: keyword) { " +
  "results { matchCount, limitHit, resultCount, results { __typename, ... on FileMatch { " +
  "repository { name }, file { path, url, content }, " +
  "lineMatches { preview, lineNumber } } } } } }";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const resultsFixture = {
  data: {
    search: {
      results: {
        matchCount: 3,
        resultCount: 2,
        limitHit: true,
        results: [
          {
            __typename: "FileMatch",
            repository: { name: "github.com/example/first" },
            file: {
              path: "src/first.ts",
              url: "https://sourcegraph.test/first",
              content: "one\ntwo\nneedle\nfour\nfive\n",
            },
            lineMatches: [{ lineNumber: 3, preview: "needle" }],
          },
          {
            __typename: "FileMatch",
            repository: { name: "github.com/example/second" },
            file: { path: "README.md", url: "", content: "" },
            lineMatches: [{ lineNumber: 8, preview: "another needle" }],
          },
        ],
      },
    },
  },
};

describe("Sourcegraph public GraphQL search migrated from Organon", () => {
  it("sends the established GraphQL request and preserves result, file, and line-context ordering", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const result = await sgraphSearch({
      query: "repo:example needle",
      count: 20,
      context: 1,
      endpoint: "http://fixture.test/graphql",
      fetch: async (receivedURL, receivedInit) => {
        url = String(receivedURL);
        init = receivedInit;
        return response(resultsFixture);
      },
    });

    expect(url).toBe("http://fixture.test/graphql");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ query: GRAPHQL_QUERY, variables: { query: "repo:example needle" } });
    expect(result).toEqual({
      content: "# Sourcegraph Search Results\n\n" +
        "Found 3 matches across 2 results\n" +
        "(Result limit reached, try a more specific query)\n\n" +
        "## Result 1: github.com/example/first/src/first.ts\n\n" +
        "URL: https://sourcegraph.test/first\n\n" +
        "```\n2| two\n3|  needle\n4| four\n```\n\n" +
        "## Result 2: github.com/example/second/README.md\n\n" +
        "```\n8| another needle\n```\n\n",
    });
  });

  it("applies the established defaults and count cap before formatting", async () => {
    const manyResults = Array.from({ length: 21 }, (_, index) => ({
      ...resultsFixture.data.search.results.results[0],
      file: { path: `src/${index + 1}.ts`, url: "", content: "one\nneedle\nthree\n" },
      lineMatches: [{ lineNumber: 2, preview: "needle" }],
    }));
    const fixture = { data: { search: { results: { matchCount: 21, resultCount: 21, results: manyResults } } } };

    const defaults = await sgraphSearch({ query: "needle", context: 0, fetch: async () => response(fixture) });
    expect(defaults.content).toContain("1| one\n2|  needle\n3| three");
    expect(defaults.content).toContain("## Result 10:");
    expect(defaults.content).not.toContain("## Result 11:");

    const capped = await sgraphSearch({ query: "needle", count: 25, fetch: async () => response(fixture) });
    expect(capped.content).toContain("## Result 20:");
    expect(capped.content).not.toContain("## Result 21:");

    const limited = await sgraphSearch({ query: "needle", count: 1, fetch: async () => response(resultsFixture) });
    expect(limited.content).toContain("## Result 1:");
    expect(limited.content).not.toContain("## Result 2:");
  });

  it("preserves no-results, limit-hit, and GraphQL error output", () => {
    expect(formatSourcegraphResults({ data: { search: { results: { matchCount: 0, resultCount: 0, results: [] } } } }, 10, 10)).toEqual(
      "# Sourcegraph Search Results\n\nFound 0 matches across 0 results\n\nNo results found. Try a different query.\n",
    );
    expect(formatSourcegraphResults({ errors: [{ message: "query timeout" }] }, 10, 10)).toEqual(
      "## Sourcegraph API Error\n\n- query timeout\n",
    );
  });

  it("rejects empty queries and malformed, HTTP, and oversized responses without remote-body disclosure", async () => {
    await expect(sgraphSearch({ query: "" })).rejects.toThrow("query is required");
    await expect(sgraphSearch({ query: "needle", fetch: async () => response({ data: {} }) })).rejects.toThrow(
      "invalid response format: missing search field",
    );
    await expect(sgraphSearch({ query: "needle", fetch: async () => new Response("not json") })).rejects.toThrow(
      "sourcegraph search: invalid JSON response",
    );
    await expect(
      sgraphSearch({ query: "needle", fetch: async () => new Response("private remote diagnostic", { status: 429 }) }),
    ).rejects.toThrow("sourcegraph search: HTTP 429");
    await expect(
      sgraphSearch({ query: "needle", fetch: async () => new Response("private remote diagnostic", { status: 429 }) }),
    ).rejects.not.toThrow("private remote diagnostic");
    await expect(
      sgraphSearch({ query: "needle", fetch: async () => new Response("x".repeat(10 * 1024 * 1024 + 1)) }),
    ).rejects.toThrow("sourcegraph search: response too large");
  });

  it("caps timeout at 120 seconds and normalizes caller cancellation", async () => {
    let transportSawAbort = false;
    const controller = new AbortController();
    const pending = sgraphSearch({
      query: "wait",
      signal: controller.signal,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          transportSawAbort = true;
          reject(new DOMException("cancelled", "AbortError"));
        });
      }),
    });
    controller.abort();
    await expect(pending).rejects.toThrow("Operation aborted");
    expect(transportSawAbort).toBe(true);

    let timeoutSawAbort = false;
    await expect(sgraphSearch({
      query: "wait",
      timeout: 0.001,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          timeoutSawAbort = true;
          reject(new DOMException("timeout", "AbortError"));
        });
      }),
    })).rejects.toThrow("sourcegraph search timed out after 0.001 seconds");
    expect(timeoutSawAbort).toBe(true);

    await expect(sgraphSearch({ query: "needle", timeout: 200, fetch: async () => response({ data: { search: { results: { matchCount: 0, resultCount: 0, results: [] } } } }) })).resolves.toMatchObject({
      content: expect.stringContaining("No results found"),
    });
  });
});
