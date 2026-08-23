import { describe, expect, it } from "vitest";

import {
  docsFetch,
  docsResolve,
  normalizeDocsToolInput,
  normalizeLibraryID,
} from "../src/index.js";

const library = {
  id: "/reactjs/react.dev",
  title: "React",
  description: "A library for user interfaces",
  trustScore: 10,
  totalSnippets: 2779,
  versions: ["18.2.0", "17.0.2"],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Context7 v1 client migrated from Organon", () => {
  it("normalizes the action-shaped docs input shared by host adapters", () => {
    expect(
      normalizeDocsToolInput({ action: "resolve", query: "react" }),
    ).toEqual({
      action: "resolve",
      query: "react",
    });
    expect(
      normalizeDocsToolInput({
        action: "fetch",
        library_id: "/reactjs/react.dev",
        topic: "hooks",
        tokens: 500,
      }),
    ).toEqual({
      action: "fetch",
      library_id: "/reactjs/react.dev",
      topic: "hooks",
      tokens: 500,
    });
    expect(() =>
      normalizeDocsToolInput({
        action: "resolve",
        query: "react",
        library_id: "/reactjs/react.dev",
      }),
    ).toThrow(
      'web_docs action "resolve" does not accept library_id, topic, or tokens',
    );
  });

  it("resolves through the v1 path, escapes the query, authenticates, and retains library fields", async () => {
    let requestURL = "";
    let headers: Headers | undefined;
    const result = await docsResolve({
      query: "react hooks & retries",
      credentials: { context7ApiKey: "  ctx7sk-fixture  " },
      endpoint: "http://context7.fixture/",
      fetch: async (url, init) => {
        requestURL = String(url);
        headers = new Headers(init?.headers);
        return json({ results: [library] });
      },
    });

    const url = new URL(requestURL);
    expect(url.pathname).toBe("/api/v1/search");
    expect(url.searchParams.get("query")).toBe("react hooks & retries");
    expect(headers?.get("authorization")).toBe("Bearer ctx7sk-fixture");
    expect(result).toEqual({
      query: "react hooks & retries",
      libraries: [
        {
          id: "/reactjs/react.dev",
          title: "React",
          description: "A library for user interfaces",
          trust_score: 10,
          total_snippets: 2779,
          versions: ["18.2.0", "17.0.2"],
        },
      ],
    });
  });

  it("allows anonymous resolution, rejects an explicitly empty key, and reports no matches", async () => {
    let authorization: string | null = "unexpected";
    const anonymous = await docsResolve({
      query: "react",
      credentials: {},
      fetch: async (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return json({ results: [{ ...library, versions: [] }] });
      },
    });
    expect(anonymous).toMatchObject({ libraries: [{ title: "React" }] });
    expect(anonymous.libraries[0]).not.toHaveProperty("versions");
    expect(authorization).toBeNull();

    await expect(
      docsResolve({ query: "react", credentials: { context7ApiKey: "  " } }),
    ).rejects.toThrow("CONTEXT7_API_KEY is set but empty");
    await expect(
      docsResolve({
        query: "not-a-library",
        credentials: {},
        fetch: async () => json({ results: [] }),
      }),
    ).rejects.toThrow('no libraries found for "not-a-library"');
  });

  it("normalizes public IDs and constructs the Context7 fetch path with topic and token controls", async () => {
    let requestURL = "";
    const result = await docsFetch({
      library_id: "//reactjs/react.dev",
      topic: "how to handle errors & retries",
      tokens: 500,
      credentials: { context7ApiKey: "fixture-key" },
      endpoint: "http://context7.fixture",
      fetch: async (url) => {
        requestURL = String(url);
        return new Response("React hooks documentation content");
      },
    });

    const url = new URL(requestURL);
    expect(url.pathname).toBe("/api/v1/reactjs/react.dev");
    expect(url.searchParams.get("type")).toBe("txt");
    expect(url.searchParams.get("topic")).toBe(
      "how to handle errors & retries",
    );
    expect(url.searchParams.get("tokens")).toBe("500");
    expect(result).toEqual({
      library_id: "/reactjs/react.dev",
      topic: "how to handle errors & retries",
      content: "React hooks documentation content",
    });
    expect(normalizeLibraryID("reactjs/react.dev")).toBe("/reactjs/react.dev");
    expect(normalizeLibraryID("//reactjs/react.dev")).toBe(
      "/reactjs/react.dev",
    );
    expect(normalizeLibraryID("")).toBe("");
  });

  it("omits empty topic and nonpositive token controls", async () => {
    let requestURL = "";
    await docsFetch({
      library_id: "/reactjs/react.dev",
      topic: "",
      tokens: 0,
      credentials: {},
      endpoint: "http://context7.fixture",
      fetch: async (url) => {
        requestURL = String(url);
        return new Response("docs");
      },
    });
    const url = new URL(requestURL);
    expect(url.searchParams.get("type")).toBe("txt");
    expect(url.searchParams.has("topic")).toBe(false);
    expect(url.searchParams.has("tokens")).toBe(false);
  });

  it("returns bounded, credential-safe errors for malformed and non-2xx remote responses", async () => {
    await expect(
      docsResolve({
        query: "react",
        credentials: {},
        fetch: async () => new Response("not-json{"),
      }),
    ).rejects.toThrow("context7 resolve: invalid JSON response");
    await expect(
      docsFetch({
        library_id: "missing/library",
        credentials: {},
        fetch: async () => new Response("not found", { status: 404 }),
      }),
    ).rejects.toThrow("Run 'web docs resolve <name>'");

    const key = "ctx7sk-very-secret";
    await expect(
      docsResolve({
        query: "react",
        credentials: { context7ApiKey: key },
        fetch: async () =>
          new Response(`${key}:${"x".repeat(10_000)}`, { status: 500 }),
      }),
    ).rejects.not.toThrow(key);
    await expect(
      docsResolve({
        query: "react",
        credentials: {},
        fetch: async () => new Response("x".repeat(10_000), { status: 500 }),
      }),
    ).rejects.toThrow(/HTTP 500: x{4096}$/);
  });
});
