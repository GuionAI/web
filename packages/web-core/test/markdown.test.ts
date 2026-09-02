import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../src/index.js";

describe("Markdown navigation", () => {
  it("uses token labels and source maps for nested, inline, and Setext headings", () => {
    const source = [
      "# Héading **bold** `code` [link](https://example.com)",
      "",
      "> ## Quote *emphasis*",
      "",
      "- ### List heading",
      "",
      "Setext heading",
      "---",
      "",
      "```markdown",
      "# fenced heading",
      "```",
      "",
      "## Duplicate",
      "first",
      "",
      "## Duplicate",
      "second",
      "",
      "## After",
      "after",
      "",
    ].join("\n");
    const tree = renderMarkdown(`${source}\n${"x".repeat(5001)}`);
    expect(tree.mode).toBe("tree");
    expect(tree.content).toContain("# Héading bold code link");
    expect(tree.content).toContain("## Quote emphasis");
    expect(tree.content).toContain("### List heading");
    expect(tree.content).toContain("## Setext heading");
    expect(tree.content).not.toContain("fenced heading");

    const duplicateIDs = [
      ...tree.content.matchAll(/\[([0-9A-Za-z]{3})\] ## Duplicate/g),
    ].map((match) => match[1]);
    expect(duplicateIDs).toHaveLength(2);
    expect(new Set(duplicateIDs).size).toBe(2);

    const quoteID = tree.content.match(
      /\[([0-9A-Za-z]{2,3})\] ## Quote emphasis/,
    )?.[1];
    expect(quoteID).toBeDefined();
    expect(
      renderMarkdown(source, { mode: "section", section_id: quoteID }),
    ).toEqual({
      mode: "section",
      content: "> ## Quote *emphasis*\n\n- ### List heading\n",
    });
  });

  it("uses the fixed automatic tree policy and explicit navigation modes", () => {
    const source =
      "# Test page\n\n## Install\nInstall content.\n\n### Details\nDetails content.\n\n## Next\nNext content.\n";
    const tree = renderMarkdown(`${source}${"x".repeat(5001)}`);
    expect(tree.mode).toBe("tree");
    expect(tree.content).toContain("[7i] ## Install");
    expect(tree.content).toContain("[eD] ### Details");

    expect(
      renderMarkdown(source, { mode: "section", section_id: "7i" }),
    ).toEqual({
      mode: "section",
      content:
        "## Install\nInstall content.\n\n### Details\nDetails content.\n",
    });
    expect(() =>
      renderMarkdown(source, { mode: "section", section_id: "missing" }),
    ).toThrow('section "missing" not found');
    expect(renderMarkdown("plain content")).toEqual({
      content: "plain content",
      mode: "full",
    });
    const complete = "# H\n\n" + "x".repeat(30_001);
    expect(renderMarkdown(complete, { mode: "full" })).toEqual({
      content: complete,
      mode: "full",
    });
  });

  it("lists and retrieves an H1-only long document section", () => {
    const source = `# Only title\n\n${"x".repeat(5001)}\n`;
    const tree = renderMarkdown(source);
    const sectionID = tree.content.match(
      /\[([0-9A-Za-z]{2,3})\] # Only title/,
    )?.[1];

    expect(tree.mode).toBe("tree");
    expect(sectionID).toBeDefined();
    expect(
      renderMarkdown(source, { mode: "section", section_id: sectionID }),
    ).toEqual({
      content: source,
      mode: "section",
    });
  });

  it("keeps headingless long documents bounded and selectable only by headings", () => {
    const source = "x".repeat(5001);
    expect(renderMarkdown(source)).toEqual({
      content: source,
      mode: "full",
    });

    const complete = "x".repeat(30_001);
    expect(renderMarkdown(complete, { mode: "full" })).toEqual({
      content: complete,
      mode: "full",
    });
  });

  it("supports explicit tree mode, including documents without headings", () => {
    expect(renderMarkdown("short content", { mode: "tree" })).toEqual({
      content: "(no headings)\n",
      mode: "tree",
    });
    expect(
      renderMarkdown("# Heading\n\ncontent\n", { mode: "tree" }).mode,
    ).toBe("tree");
  });

  it("requires section mode and rejects incompatible navigation fields", () => {
    expect(() => renderMarkdown("# Heading\n")).not.toThrow();
    expect(() => renderMarkdown("# Heading\n", { mode: "section" })).toThrow(
      'section_id is required when mode is "section"',
    );
    expect(() =>
      renderMarkdown("# Heading\n", { mode: "auto", section_id: "x" }),
    ).toThrow('section_id is only valid with mode "section"');
    expect(() =>
      renderMarkdown("# Heading\n", { mode: "full", section_id: "x" }),
    ).toThrow('section_id is only valid with mode "section"');
    expect(() =>
      renderMarkdown("# Heading\n", { mode: "invalid" as never }),
    ).toThrow('mode must be one of "auto", "full", "tree", or "section"');
  });
});
