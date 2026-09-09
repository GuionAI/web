import { createElement } from "react";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DEFAULT_LINK_LIMIT } from "@guionai/web-core";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { ResearchToolRow, researchParameters } from "../src/tool-row.js";

const require = createRequire(import.meta.url);
const renderToStaticMarkup = require("react-dom/server")
  .renderToStaticMarkup as (element: unknown) => string;
function settled(
  name: string,
  args: object,
  output = "Returned research text",
): ToolCallViewProps {
  return {
    toolName: name,
    block: {
      kind: "tool-result",
      callId: "call-1",
      name,
      call: { name, argsRaw: JSON.stringify(args) },
      content: [{ type: "text", text: output }],
      isError: false,
    },
  } as ToolCallViewProps;
}

describe("compact research presentation", () => {
  it("keeps default page choices out of the row", () => {
    expect(
      researchParameters("web_fetch", { render: "http", mode: "auto" }),
    ).toEqual([]);
    expect(
      researchParameters("web_links", { limit: DEFAULT_LINK_LIMIT }),
    ).toEqual([]);
    expect(researchParameters("web_docs", { tokens: 0 })).toEqual([]);
    expect(
      researchParameters("web_source_search", {
        count: 10,
        context: 10,
        timeout: 0,
      }),
    ).toEqual([]);
  });
  it("shows browser waits and navigation choices without provider configuration", () => {
    expect(
      researchParameters("web_fetch", {
        render: "browser",
        waitMs: 0,
        section_id: "install",
        mode: "auto",
      }),
    ).toEqual(["browser", "wait: 0 s", "section: install"]);
    expect(researchParameters("web_fetch", { mode: "tree" })).toEqual([
      "mode: tree",
    ]);
    expect(
      researchParameters("web_links", {
        render: "browser",
        waitMs: 250,
        limit: 5,
      }),
    ).toEqual(["browser", "wait: 0.25 s", "limit: 5"]);
    expect(
      researchParameters("web_docs", { topic: "routing", tokens: 2000 }),
    ).toEqual(["topic: routing", "tokens: 2000"]);
  });
  it("renders a collapsed native row without mounting a long result", () => {
    const html = renderToStaticMarkup(
      createElement(
        ResearchToolRow,
        settled(
          "web_fetch",
          { url: "https://example.test/docs", mode: "tree" },
          "RESULT".repeat(10000),
        ),
      ),
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="button"');
    expect(html).toContain("https://example.test/docs");
    expect(html).toContain("mode: tree");
    expect(html).not.toContain("RESULT");
  });
  it.each([
    ["web_search", { queries: ["one", "two"] }, "one, two"],
    ["web_docs", { action: "resolve", query: "React" }, "Find documentation"],
    ["web_source_search", { query: "repo:test symbol" }, "repo:test symbol"],
    ["web_weather", { location: "Taipei" }, "Taipei"],
    [
      "web_sports",
      { league: "nba", fn: "schedule", team: "BOS" },
      "nba · schedule · BOS",
    ],
    ["web_finance", { ticker: "MSFT" }, "MSFT"],
    ["web_time", { utc_offset: "+08:00" }, "+08:00"],
  ])("shows the %s request target", (name, args, expected) => {
    const html = renderToStaticMarkup(
      createElement(ResearchToolRow, settled(name, args)),
    );
    expect(html).toContain(expected);
  });
  it("distinguishes failed and running calls without requiring complete arguments", () => {
    const failed = settled("web_fetch", { url: "https://example.test" });
    failed.block = {
      ...failed.block,
      isError: true,
    } as ToolCallViewProps["block"];
    expect(
      renderToStaticMarkup(createElement(ResearchToolRow, failed)),
    ).toContain("Failed");
    const running = {
      toolName: "web_fetch",
      block: { callId: "call-1", name: "web_fetch", argsRaw: '{"url":' },
    } as ToolCallViewProps;
    expect(
      renderToStaticMarkup(createElement(ResearchToolRow, running)),
    ).toContain("Working…");
  });
});
