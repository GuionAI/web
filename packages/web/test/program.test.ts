import { describe, expect, it, vi } from "vitest";

import { FetchCapabilityError } from "@guionai/web-core";
import { createProgram } from "../src/program.js";
import { runCli } from "../src/runner.js";

const result = {
  provider: "Brave" as const,
  results: [
    {
      title: "Result",
      link: "https://example.test",
      snippet: "Fixture result",
      position: 1,
    },
  ],
};

function setup() {
  const operations = {
    search: vi.fn(async () => result),
    fetch: vi.fn(async () => ({
      url: "https://example.test/page",
      mode: "full" as const,
      content: "# Fixture page\n",
    })),
    links: vi.fn(async (input: { url: string }) => ({
      url: input.url,
      links: [{ text: "Fixture link", url: "https://example.test/link" }],
      truncated: false,
    })),
    docsResolve: vi.fn(),
    docsFetch: vi.fn(),
    sgraphSearch: vi.fn(async () => ({
      content: "# Sourcegraph Search Results\n",
    })),
    keposBridge: vi.fn(),
  };
  let stdout = "";
  const program = createProgram({
    operations,
    credentials: () => ({ braveApiKey: "fixture-key" }),
    writeOut: (text) => {
      stdout += text;
    },
  });
  let stderr = "";
  return { program, operations, output: () => ({ stdout, stderr }) };
}

describe("web search Commander adapter", () => {
  it("passes an explicit provider and writes concise human output to stdout", async () => {
    const { program, operations, output } = setup();
    await program.parseAsync(["search", "tree sitter", "--provider", "brave"], {
      from: "user",
    });

    expect(operations.search).toHaveBeenCalledWith({
      query: "tree sitter",
      provider: "brave",
      credentials: { braveApiKey: "fixture-key" },
    });
    expect(output()).toEqual({
      stdout:
        "Found 1 search results:\n\n1. Result\n   URL: https://example.test\n   Summary: Fixture result\n\n",
      stderr: "",
    });
  });

  it("accepts a flag-like query after -- and emits exactly one JSON document", async () => {
    const { program, operations, output } = setup();
    await program.parseAsync(
      ["search", "--provider", "exa", "--json", "--", "-flag-like-query"],
      { from: "user" },
    );

    expect(operations.search).toHaveBeenCalledWith({
      query: "-flag-like-query",
      provider: "exa",
      credentials: { braveApiKey: "fixture-key" },
    });
    expect(output().stderr).toBe("");
    expect(output().stdout).toBe(JSON.stringify(result) + "\n");
    expect(JSON.parse(output().stdout)).toEqual(result);
  });

  it("maps Sourcegraph flags, protects hyphenated queries with --, and emits one JSON document", async () => {
    const { program, operations, output } = setup();
    await program.parseAsync(
      [
        "sgraph",
        "--count",
        "14",
        "--context",
        "3",
        "--timeout",
        "9",
        "--json",
        "--",
        "-repo:test",
      ],
      { from: "user" },
    );

    expect(operations.sgraphSearch).toHaveBeenCalledWith({
      query: "-repo:test",
      count: 14,
      context: 3,
      timeout: 9,
    });
    expect(output().stdout).toBe(
      '{"content":"# Sourcegraph Search Results\\n"}\n',
    );
    expect(JSON.parse(output().stdout)).toEqual({
      content: "# Sourcegraph Search Results\n",
    });
  });

  it("dispatches nested docs commands with established human and one-document JSON output", async () => {
    const { program, operations, output } = setup();
    operations.docsResolve.mockResolvedValue({
      query: "react",
      libraries: [
        {
          id: "/reactjs/react.dev",
          title: "React",
          description: "UI",
          trust_score: 10,
          total_snippets: 2779,
          versions: ["18.2.0"],
        },
      ],
    });
    await program.parseAsync(["docs", "resolve", "react"], { from: "user" });
    expect(operations.docsResolve).toHaveBeenCalledWith({
      query: "react",
      credentials: { braveApiKey: "fixture-key" },
    });
    expect(output().stdout).toContain(
      "Found 1 libraries:\n\n1. React\n   ID: /reactjs/react.dev\n   Trust: 10.0   Snippets: 2779\n   Versions: 18.2.0\n   UI\n",
    );

    let jsonOutput = "";
    const docsFetch = vi.fn(async () => ({
      library_id: "/reactjs/react.dev",
      topic: "hooks",
      content: "Documentation\n",
    }));
    const fetchProgram = createProgram({
      operations: { ...operations, docsFetch },
      credentials: () => ({ context7ApiKey: "fixture-key" }),
      writeOut: (text) => {
        jsonOutput += text;
      },
    });
    await fetchProgram.parseAsync(
      [
        "docs",
        "fetch",
        "--tokens",
        "500",
        "--json",
        "--",
        "reactjs/react.dev",
        "hooks",
      ],
      { from: "user" },
    );
    expect(docsFetch).toHaveBeenCalledWith({
      library_id: "reactjs/react.dev",
      topic: "hooks",
      tokens: 500,
      credentials: { context7ApiKey: "fixture-key" },
    });
    expect(jsonOutput).toBe(
      '{"library_id":"/reactjs/react.dev","topic":"hooks","content":"Documentation\\n"}\n',
    );
    expect(JSON.parse(jsonOutput)).toMatchObject({
      library_id: "/reactjs/react.dev",
      topic: "hooks",
    });
  });

  it("passes fetch navigation flags and writes human Markdown", async () => {
    const { program, operations, output } = setup();
    await program.parseAsync(
      ["fetch", "https://example.test/page", "-s", "7i"],
      { from: "user" },
    );

    expect(operations.fetch).toHaveBeenCalledWith({
      url: "https://example.test/page",
      section_id: "7i",
    });
    expect(output()).toEqual({ stdout: "# Fixture page\n", stderr: "" });
  });

  it("forwards explicit browser rendering options", async () => {
    const { program, operations } = setup();
    await program.parseAsync(
      ["fetch", "https://example.test/page", "--render=browser", "--wait=0"],
      { from: "user" },
    );

    expect(operations.fetch).toHaveBeenCalledWith({
      url: "https://example.test/page",
      render: "browser",
      waitMs: 0,
    });
  });

  it("writes fetch JSON as exactly one document", async () => {
    const { program, operations, output } = setup();
    await program.parseAsync(
      ["fetch", "https://example.test/page", "--full", "--json"],
      { from: "user" },
    );

    expect(operations.fetch).toHaveBeenCalledWith({
      url: "https://example.test/page",
      full: true,
    });
    expect(JSON.parse(output().stdout)).toEqual(
      await operations.fetch.mock.results[0]!.value,
    );
    expect(output().stdout.endsWith("\n")).toBe(true);
  });

  it("forwards link discovery options and supports concise and JSON output", async () => {
    const { program, operations, output } = setup();
    await program.parseAsync(
      [
        "links",
        "https://example.test/page",
        "--limit",
        "25",
        "--render=browser",
        "--wait=0",
      ],
      { from: "user" },
    );

    expect(operations.links).toHaveBeenCalledWith({
      url: "https://example.test/page",
      limit: 25,
      render: "browser",
      waitMs: 0,
    });
    expect(output()).toEqual({
      stdout:
        "Found 1 link:\n\n1. Fixture link\n   URL: https://example.test/link\n\n",
      stderr: "",
    });

    await program.parseAsync(["links", "https://example.test/page", "--json"], {
      from: "user",
    });
    expect(JSON.parse(output().stdout.split("\n").at(-2)!)).toEqual(
      await operations.links.mock.results[1]!.value,
    );
  });

  it("formats the browser retry guidance without partial stdout", async () => {
    const operations = {
      search: vi.fn(),
      fetch: vi.fn(async () => {
        throw new FetchCapabilityError("javascript_rendering_may_be_required", {
          retryableWithRender: true,
          suggestedArguments: { render: "browser", waitMs: 2000 },
        });
      }),
      links: vi.fn(),
      docsResolve: vi.fn(),
      docsFetch: vi.fn(),
      sgraphSearch: vi.fn(),
      keposBridge: vi.fn(),
    };
    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(
      ["node", "web", "fetch", "https://example.test/page"],
      { operations, credentials: () => ({}) },
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "javascript_rendering_may_be_required: content may require JavaScript rendering\n" +
        "Retry: web fetch <url> --render=browser --wait=2000\n",
    );
  });

  it("returns nonzero failures to stderr without writing a partial stdout result", async () => {
    const operations = {
      search: vi.fn(async () => {
        throw new Error(
          "EXA_API_KEY is required when --provider exa is selected",
        );
      }),
      fetch: vi.fn(),
      links: vi.fn(),
      docsResolve: vi.fn(),
      docsFetch: vi.fn(),
      sgraphSearch: vi.fn(),
      keposBridge: vi.fn(),
    };
    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(
      ["node", "web", "search", "query", "--provider", "exa"],
      { operations, credentials: () => ({}) },
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "EXA_API_KEY is required when --provider exa is selected\n",
    );
  });
});
