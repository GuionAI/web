import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../src/index.js";

describe("Markdown navigation migrated from Organon", () => {
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

    const tree = renderMarkdown(source, true, undefined, false, 5000);
    expect(tree.mode).toBe("tree");
    expect(tree.content).toContain("# Héading bold code link");
    expect(tree.content).toContain("## Quote emphasis");
    expect(tree.content).toContain("### List heading");
    expect(tree.content).toContain("## Setext heading");
    expect(tree.content).not.toContain("fenced heading");

    const duplicateIDs = [...tree.content.matchAll(/\[([0-9A-Za-z]{3})\] ## Duplicate/g)].map((match) => match[1]);
    expect(duplicateIDs).toHaveLength(2);
    expect(new Set(duplicateIDs).size).toBe(2);

    const quoteID = tree.content.match(/\[([0-9A-Za-z]{2,3})\] ## Quote emphasis/)?.[1];
    expect(quoteID).toBeDefined();
    expect(renderMarkdown(source, false, quoteID, false, 5000)).toEqual({
      mode: "section",
      content: "> ## Quote *emphasis*\n\n- ### List heading\n",
    });
  });

  it("preserves opaque IDs and full, tree, section, threshold, and truncation modes", () => {
    const source = "# Test page\n\n## Install\nInstall content.\n\n### Details\nDetails content.\n\n## Next\nNext content.\n";
    const tree = renderMarkdown(source, true, undefined, false, 5000);
    expect(tree).toMatchObject({ mode: "tree" });
    expect(tree.content).toContain("[7i] ## Install");
    expect(tree.content).toContain("[eD] ### Details");

    expect(renderMarkdown(source, false, "7i", false, 5000)).toEqual({
      mode: "section",
      content: "## Install\nInstall content.\n\n### Details\nDetails content.\n",
    });
    expect(() => renderMarkdown(source, false, "missing", false, 5000)).toThrow('section "missing" not found');
    expect(renderMarkdown("plain content", true, undefined, false, 1)).toEqual({ content: "plain content", mode: "full" });
    expect(renderMarkdown("# H\n\n" + "x".repeat(6000), false, undefined, false, 5000).mode).toBe("tree");
    expect(renderMarkdown("# H\n\n" + "x".repeat(6000), false, undefined, true, 1).mode).toBe("full");

    const unicode = "😀".repeat(30_001);
    const bounded = renderMarkdown(unicode, false, undefined, false, 50_000);
    expect(Array.from(bounded.content.split("\n[content truncated")[0]!).length).toBe(30_000);
    expect(bounded.content).toContain("[content truncated at 30000 characters]");
  });
});
