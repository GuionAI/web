import { describe, expect, it } from "vitest";

import { docsFetch, docsResolve, normalizeLibraryID } from "../src/index.js";

const library = {
  id: "/reactjs/react.dev",
  title: "React",
  description: "A library for user interfaces",
  trustScore: 10,
  totalSnippets: 2779,
  versions: ["18.2.0", "17.0.2"],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("Context7 v1 client migrated from Organon", () => {
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
      libraries: [{
        id: "/reactjs/react.dev",
        title: "React",
        description: "A library for user interfaces",
        trust_score: 10,
        total_snippets: 2779,
        versions: ["18.2.0", "17.0.2"],
      }],
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

    await expect(docsResolve({ query: "react", credentials: { context7ApiKey: "  " } })).rejects.toThrow(
      "CONTEXT7_API_KEY is set but empty",
    );
    await expect(docsResolve({ query: "not-a-library", credentials: {}, fetch: async () => json({ results: [] }) })).rejects.toThrow(
      'no libraries found for "not-a-library"',
    );
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
    expect(url.searchParams.get("topic")).toBe("how to handle errors & retries");
    expect(url.searchParams.get("tokens")).toBe("500");
    expect(result).toEqual({
      library_id: "/reactjs/react.dev",
      topic: "how to handle errors & retries",
      content: "React hooks documentation content",
    });
    expect(normalizeLibraryID("reactjs/react.dev")).toBe("/reactjs/react.dev");
    expect(normalizeLibraryID("//reactjs/react.dev")).toBe("/reactjs/react.dev");
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
    await expect(docsResolve({ query: "react", credentials: {}, fetch: async () => new Response("not-json{") })).rejects.toThrow(
      "context7 resolve: invalid JSON response",
    );
    await expect(docsFetch({
      library_id: "missing/library",
      credentials: {},
      fetch: async () => new Response("not found", { status: 404 }),
    })).rejects.toThrow("Run 'web docs resolve <name>'");

    const key = "ctx7sk-very-secret";
    await expect(docsResolve({
      query: "react",
      credentials: { context7ApiKey: key },
      fetch: async () => new Response(`${key}:${"x".repeat(10_000)}`, { status: 500 }),
    })).rejects.not.toThrow(key);
    await expect(docsResolve({
      query: "react",
      credentials: {},
      fetch: async () => new Response("x".repeat(10_000), { status: 500 }),
    })).rejects.toThrow(/HTTP 500: x{4096}$/);
  });

  it("cancels the native transport and enforces the bounded request timeout", async () => {
    const controller = new AbortController();
    let transportSawAbort = false;
    const pending = docsResolve({
      query: "wait",
      credentials: {},
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

    const bodyController = new AbortController();
    let bodySawCancel = false;
    let startReading: () => void;
    const readingStarted = new Promise<void>((resolve) => { startReading = resolve; });
    let releasePull: () => void;
    const bodyPending = docsFetch({
      library_id: "reactjs/react.dev",
      credentials: {},
      signal: bodyController.signal,
      fetch: async () => new Response(new ReadableStream({
        pull() {
          startReading!();
          return new Promise<void>((resolve) => { releasePull = resolve; });
        },
        cancel() {
          bodySawCancel = true;
          releasePull!();
        },
      })),
    });
    await readingStarted;
    bodyController.abort();
    await expect(bodyPending).rejects.toThrow("Operation aborted");
    expect(bodySawCancel).toBe(true);

    await expect(docsFetch({
      library_id: "reactjs/react.dev",
      credentials: {},
      timeoutMs: 1,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
      }),
    })).rejects.toThrow("context7 docs timed out after 0.001 seconds");
  });
});
