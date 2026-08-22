import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/program.js";
import { runCli } from "../src/runner.js";

const result = {
  provider: "Brave" as const,
  results: [{ title: "Result", link: "https://example.test", snippet: "Fixture result", position: 1 }],
};

function setup() {
  const service = { search: vi.fn(async () => result) };
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

  it("returns nonzero failures to stderr without writing a partial stdout result", async () => {
    const service = { search: vi.fn(async () => { throw new Error("EXA_API_KEY is required when --provider exa is selected"); }) };
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
