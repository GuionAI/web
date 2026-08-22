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
