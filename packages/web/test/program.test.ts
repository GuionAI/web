import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/program.js";
import { runCli } from "../src/runner.js";

const result = {
  provider: "Brave" as const,
  results: [{ title: "Result", link: "https://example.test", snippet: "Fixture result", position: 1 }],
};

function setup() {
  const service = {
    search: vi.fn(async () => result),
    fetch: vi.fn(async () => ({
      url: "https://example.test/page",
      mode: "full" as const,
      content: "# Fixture page\n",
    })),
    docsResolve: vi.fn(),
    docsFetch: vi.fn(),
    sgraphSearch: vi.fn(async () => ({ content: "# Sourcegraph Search Results\n" })),
  };
  let stdout = "";
  const program = createProgram({
    service,
    credentials: () => ({ braveApiKey: "fixture-key" }),
    writeOut: (text) => {
      stdout += text;
    },
  });
  let stderr = "";
  return { program, service, output: () => ({ stdout, stderr }) };
}

describe("web search Commander adapter", () => {
  it("passes an explicit provider and writes concise human output to stdout", async () => {
    const { program, service, output } = setup();
    await program.parseAsync(["search", "tree sitter", "--provider", "brave"], { from: "user" });

    expect(service.search).toHaveBeenCalledWith({
      query: "tree sitter",
      provider: "brave",
      credentials: { braveApiKey: "fixture-key" },
    });
    expect(output()).toEqual({
      stdout: "Found 1 search results:\n\n1. Result\n   URL: https://example.test\n   Summary: Fixture result\n\n",
      stderr: "",
    });
  });

  it("accepts a flag-like query after -- and emits exactly one JSON document", async () => {
    const { program, service, output } = setup();
    await program.parseAsync(["search", "--provider", "exa", "--json", "--", "-flag-like-query"], { from: "user" });

    expect(service.search).toHaveBeenCalledWith({
      query: "-flag-like-query",
      provider: "exa",
      credentials: { braveApiKey: "fixture-key" },
    });
    expect(output().stderr).toBe("");
    expect(output().stdout).toBe(JSON.stringify(result) + "\n");
    expect(JSON.parse(output().stdout)).toEqual(result);
  });

  it("maps Sourcegraph flags, protects hyphenated queries with --, and emits one JSON document", async () => {
    const { program, service, output } = setup();
    await program.parseAsync(["sgraph", "--count", "14", "--context", "3", "--timeout", "9", "--json", "--", "-repo:test"], { from: "user" });

    expect(service.sgraphSearch).toHaveBeenCalledWith({ query: "-repo:test", count: 14, context: 3, timeout: 9 });
    expect(output().stdout).toBe('{"content":"# Sourcegraph Search Results\\n"}\n');
    expect(JSON.parse(output().stdout)).toEqual({ content: "# Sourcegraph Search Results\n" });
  });

  it("dispatches nested docs commands with established human and one-document JSON output", async () => {
    const { program, service, output } = setup();
    service.docsResolve.mockResolvedValue({
      query: "react",
      libraries: [{ id: "/reactjs/react.dev", title: "React", description: "UI", trust_score: 10, total_snippets: 2779, versions: ["18.2.0"] }],
    });
    await program.parseAsync(["docs", "resolve", "react"], { from: "user" });
    expect(service.docsResolve).toHaveBeenCalledWith({ query: "react", credentials: { braveApiKey: "fixture-key" } });
    expect(output().stdout).toContain("Found 1 libraries:\n\n1. React\n   ID: /reactjs/react.dev\n   Trust: 10.0   Snippets: 2779\n   Versions: 18.2.0\n   UI\n");

    let jsonOutput = "";
    const docsFetch = vi.fn(async () => ({ library_id: "/reactjs/react.dev", topic: "hooks", content: "Documentation\n" }));
    const fetchProgram = createProgram({
      service: { ...service, docsFetch },
      credentials: () => ({ context7ApiKey: "fixture-key" }),
      writeOut: (text) => { jsonOutput += text; },
    });
    await fetchProgram.parseAsync(["docs", "fetch", "--tokens", "500", "--json", "--", "reactjs/react.dev", "hooks"], { from: "user" });
    expect(docsFetch).toHaveBeenCalledWith({
      library_id: "reactjs/react.dev",
      topic: "hooks",
      tokens: 500,
      credentials: { context7ApiKey: "fixture-key" },
    });
    expect(jsonOutput).toBe('{"library_id":"/reactjs/react.dev","topic":"hooks","content":"Documentation\\n"}\n');
    expect(JSON.parse(jsonOutput)).toMatchObject({ library_id: "/reactjs/react.dev", topic: "hooks" });
  });

  it("passes fetch navigation flags and writes human Markdown", async () => {
    const { program, service, output } = setup();
    await program.parseAsync(["fetch", "https://example.test/page", "--tree", "-s", "7i", "--tree-threshold", "9000"], { from: "user" });

    expect(service.fetch).toHaveBeenCalledWith({
      url: "https://example.test/page",
      tree: true,
      section_id: "7i",
      full: undefined,
      tree_threshold: 9000,
    });
    expect(output()).toEqual({ stdout: "# Fixture page\n", stderr: "" });
  });

  it("writes fetch JSON as exactly one document", async () => {
    const { program, service, output } = setup();
    await program.parseAsync(["fetch", "https://example.test/page", "--full", "--json"], { from: "user" });

    expect(service.fetch).toHaveBeenCalledWith({
      url: "https://example.test/page",
      tree: undefined,
      section_id: undefined,
      full: true,
      tree_threshold: undefined,
    });
    expect(JSON.parse(output().stdout)).toEqual(await service.fetch.mock.results[0]!.value);
    expect(output().stdout.endsWith("\n")).toBe(true);
  });

  it("returns nonzero failures to stderr without writing a partial stdout result", async () => {
    const service = {
      search: vi.fn(async () => { throw new Error("EXA_API_KEY is required when --provider exa is selected"); }),
      fetch: vi.fn(),
      docsResolve: vi.fn(),
      docsFetch: vi.fn(),
      sgraphSearch: vi.fn(),
    };
    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(
      ["node", "web", "search", "query", "--provider", "exa"],
      { service, credentials: () => ({}) },
      { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("EXA_API_KEY is required when --provider exa is selected\n");
  });
});
