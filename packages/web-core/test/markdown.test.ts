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
    expect(renderMarkdown(source, { section_id: quoteID })).toEqual({
      mode: "section",
      content: "> ## Quote *emphasis*\n\n- ### List heading\n",
      truncated: false,
    });
  });

  it("uses the fixed automatic tree policy and explicit navigation modes", () => {
    const source =
      "# Test page\n\n## Install\nInstall content.\n\n### Details\nDetails content.\n\n## Next\nNext content.\n";
    const tree = renderMarkdown(`${source}${"x".repeat(5001)}`);
    expect(tree.mode).toBe("tree");
    expect(tree.content).toContain("[7i] ## Install");
    expect(tree.content).toContain("[eD] ### Details");

    expect(renderMarkdown(source, { section_id: "7i" })).toEqual({
      mode: "section",
      content:
        "## Install\nInstall content.\n\n### Details\nDetails content.\n",
      truncated: false,
    });
    expect(() => renderMarkdown(source, { section_id: "missing" })).toThrow(
      'section "missing" not found',
    );
    expect(renderMarkdown("plain content")).toEqual({
      content: "plain content",
      mode: "auto",
      truncated: false,
    });
    const complete = "# H\n\n" + "x".repeat(30_001);
    expect(renderMarkdown(complete, { mode: "full" })).toEqual({
      content: complete,
      mode: "full",
      truncated: false,
    });
    const bounded = renderMarkdown("x".repeat(30_001));
    expect(bounded.mode).toBe("auto");
    expect(bounded.truncated).toBe(true);
    expect(bounded.content).toContain(
      "[content truncated at 30000 characters]",
    );
  });

  it("lists and retrieves an H1-only long document section", () => {
    const source = `# Only title\n\n${"x".repeat(5001)}\n`;
    const tree = renderMarkdown(source);
    const sectionID = tree.content.match(
      /\[([0-9A-Za-z]{2,3})\] # Only title/,
    )?.[1];

    expect(tree.mode).toBe("tree");
    expect(sectionID).toBeDefined();
    expect(renderMarkdown(source, { section_id: sectionID })).toEqual({
      content: source,
      mode: "section",
      truncated: false,
    });
  });

  it("keeps headingless long documents in auto mode and bounded when necessary", () => {
    const source = "x".repeat(5001);
    expect(renderMarkdown(source)).toEqual({
      content: source,
      mode: "auto",
      truncated: false,
    });

    const complete = "x".repeat(30_001);
    expect(renderMarkdown(complete, { mode: "full" })).toEqual({
      content: complete,
      mode: "full",
      truncated: false,
    });
  });

  it("supports explicit tree mode, including documents without headings", () => {
    expect(renderMarkdown("short content", { mode: "tree" })).toEqual({
      content: "(no headings)\n",
      mode: "tree",
      truncated: false,
    });
    expect(
      renderMarkdown("# Heading\n\ncontent\n", { mode: "tree" }).mode,
    ).toBe("tree");
  });

  it("allows auto section continuation and rejects incompatible navigation fields", () => {
    const source = "# Heading\n\n## Install\nInstall content.\n";
    expect(renderMarkdown(source, { section_id: "7i" })).toEqual({
      mode: "section",
      content: "## Install\nInstall content.\n",
      truncated: false,
    });
    expect(renderMarkdown(source, { mode: "auto", section_id: "7i" })).toEqual({
      mode: "section",
      content: "## Install\nInstall content.\n",
      truncated: false,
    });
    expect(() =>
      renderMarkdown("# Heading\n", { mode: "section" as never }),
    ).toThrow('mode must be one of "auto", "full", or "tree"');
    expect(() =>
      renderMarkdown("# Heading\n", { mode: "full", section_id: "x" }),
    ).toThrow('section_id is only valid with mode "auto"');
    expect(() =>
      renderMarkdown("# Heading\n", { mode: "tree", section_id: "x" }),
    ).toThrow('section_id is only valid with mode "auto"');
    expect(() =>
      renderMarkdown("# Heading\n", { mode: "invalid" as never }),
    ).toThrow('mode must be one of "auto", "full", or "tree"');
  });
});
