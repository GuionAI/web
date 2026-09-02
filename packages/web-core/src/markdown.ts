import { createHash } from "node:crypto";

import MarkdownIt from "markdown-it";

type MarkdownToken = ReturnType<
  InstanceType<typeof MarkdownIt>["parse"]
>[number];

type Heading = {
  level: number;
  text: string;
  start: number;
  id: string;
};

export type MarkdownResult = {
  content: string;
  mode: "full" | "tree" | "section";
};

export const FETCH_MODES = ["auto", "full", "tree", "section"] as const;
export type FetchMode = (typeof FETCH_MODES)[number];

export type MarkdownNavigationOptions = {
  mode?: FetchMode;
  section_id?: string;
};

const DEFAULT_TREE_THRESHOLD = 5000;
const MAX_CONTENT_CHARS = 30_000;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Block-token source maps remain the source of truth for section offsets,
// including headings nested inside lists and block quotes.
const markdown = new MarkdownIt();

export function renderMarkdown(
  source: string,
  options: MarkdownNavigationOptions = {},
): MarkdownResult {
  validateNavigationOptions(options);
  const headings = assignIds(parseHeadings(source));
  const mode = options.mode ?? "auto";
  const section = options.section_id?.trim();
  if (mode === "section") {
    if (!section)
      throw new Error('section_id is required when mode is "section"');
    return {
      content: extractSection(source, headings, section),
      mode: "section",
    };
  }
  if (section !== undefined)
    throw new Error('section_id is only valid with mode "section"');

  if (mode === "tree") return { content: renderTree(source, headings), mode };

  if (mode === "full")
    return {
      content: source,
      mode: "full",
    };

  const charCount = Array.from(source).length;
  if (charCount > DEFAULT_TREE_THRESHOLD && headings.length > 0)
    return { content: renderTree(source, headings), mode: "tree" };
  return {
    content: truncateContent(source),
    mode: "full",
  };
}

function validateNavigationOptions(options: object): void {
  for (const field of Object.keys(options)) {
    if (field !== "mode" && field !== "section_id")
      throw new Error(`navigation options do not accept field ${field}`);
  }

  const mode = (options as { mode?: unknown }).mode;
  if (mode !== undefined && !FETCH_MODES.includes(mode as FetchMode))
    throw new Error('mode must be one of "auto", "full", "tree", or "section"');

  const section = (options as { section_id?: unknown }).section_id;
  if (
    section !== undefined &&
    (typeof section !== "string" || section.trim() === "")
  )
    throw new Error("section_id must be a non-empty string");
}

export function truncateContent(content: string): string {
  const chars = Array.from(content);
  if (chars.length <= MAX_CONTENT_CHARS) return content;
  return (
    chars.slice(0, MAX_CONTENT_CHARS).join("") +
    `\n[content truncated at ${MAX_CONTENT_CHARS} characters]`
  );
}

function parseHeadings(source: string): Omit<Heading, "id">[] {
  const tokens = markdown.parse(source, {});
  const lineOffsets = getLineOffsets(source);
  const headings: Omit<Heading, "id">[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token.type !== "heading_open") continue;

    const inline = tokens[index + 1];
    const line = token.map?.[0] ?? 0;
    headings.push({
      level: Number(token.tag.slice(1)),
      text: headingText(inline),
      start: lineOffsets[line] ?? source.length,
    });
  }
  return headings;
}

function getLineOffsets(source: string): number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function headingText(token: MarkdownToken | undefined): string {
  if (!token || token.type !== "inline") return "";
  return (token.children ?? [])
    .map(inlineTokenText)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function inlineTokenText(token: MarkdownToken): string {
  switch (token.type) {
    case "text":
    case "code_inline":
    case "image":
      return token.content;
    case "softbreak":
    case "hardbreak":
      return " ";
    default:
      return "";
  }
}

function assignIds(headings: Omit<Heading, "id">[]): Heading[] {
  const labels = headings.map(
    (heading) => `${"#".repeat(heading.level)} ${heading.text}`,
  );
  const ids = labels.map((label) => hashBase62(label, 2));
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return headings.map((heading, index) => ({
    ...heading,
    id:
      counts.get(ids[index]!)! > 1
        ? hashBase62(`${labels[index]}\0${index}`, 3)
        : ids[index]!,
  }));
}

function hashBase62(value: string, length: number): string {
  const digest = createHash("sha256").update(value).digest();
  let number = 0n;
  for (const byte of digest.subarray(0, 8))
    number = (number << 8n) | BigInt(byte);
  let output = "";
  while (number > 0n) {
    output = BASE62[Number(number % 62n)] + output;
    number /= 62n;
  }
  return output.padStart(length, "0").slice(-length);
}

function extractSection(
  source: string,
  headings: Heading[],
  sectionId: string,
): string {
  const targetIndex = headings.findIndex((heading) => heading.id === sectionId);
  if (targetIndex < 0) {
    const available = headings
      .filter((heading) => heading.id !== "")
      .map((heading) => `${JSON.stringify(heading.id)} (${heading.text})`)
      .join(", ");
    throw new Error(
      `section ${JSON.stringify(sectionId)} not found; available: ${available}`,
    );
  }
  const target = headings[targetIndex]!;
  let end = source.length;
  for (const heading of headings.slice(targetIndex + 1)) {
    if (heading.level <= target.level) {
      end = heading.start;
      break;
    }
  }
  return source.slice(target.start, end).replace(/\n+$/, "") + "\n";
}

function renderTree(source: string, headings: Heading[]): string {
  if (headings.length === 0) return "(no headings)\n";

  let header = "";
  if (headings[0]!.level === 1) {
    header = `# ${headings[0]!.text}\n\nTotal: ${formatNumber(sectionCharCount(source, headings, 0))} characters\n\n`;
  }

  const bodyHeadings = headings.filter((heading) => heading.level > 1);
  const minLevel = bodyHeadings.reduce(
    (min, heading) => Math.min(min, heading.level),
    99,
  );
  if (bodyHeadings.length === 0) {
    const tree = headings
      .map(
        (heading, index) =>
          `└── [${heading.id}] ${"#".repeat(heading.level)} ${heading.text}  (${formatNumber(sectionCharCount(source, headings, index))} chars)\n`,
      )
      .join("");
    return `${header}${tree}\nUse mode: "section" with section_id to read a section, or mode: "full" to read everything.\n`;
  }

  const nodes = bodyHeadings.map((heading) => {
    const index = headings.indexOf(heading);
    return {
      heading,
      depth: heading.level - (minLevel === 99 ? 2 : minLevel),
      meta: `(${formatNumber(sectionCharCount(source, headings, index))} chars)`,
    };
  });

  const hasMore = new Map<number, boolean>();
  let tree = "";
  nodes.forEach((node, index) => {
    const next = nodes
      .slice(index + 1)
      .find((future) => future.depth <= node.depth);
    const isLast = !next || next.depth < node.depth;
    let indent = "";
    for (let depth = 0; depth < node.depth; depth++) {
      indent += hasMore.get(depth) ? "│   " : "    ";
    }
    tree += `${indent}${isLast ? "└── " : "├── "}[${node.heading.id}] ${"#".repeat(node.heading.level)} ${node.heading.text}  ${node.meta}\n`;
    hasMore.set(node.depth, !isLast);
    for (let depth = node.depth + 1; depth < node.depth + 10; depth++)
      hasMore.delete(depth);
  });

  return `${header}${tree}\nUse mode: "section" with section_id to read a section, or mode: "full" to read everything.\n`;
}

function sectionCharCount(
  source: string,
  headings: Heading[],
  index: number,
): number {
  const heading = headings[index]!;
  let end = source.length;
  for (const next of headings.slice(index + 1)) {
    if (next.level <= heading.level) {
      end = next.start;
      break;
    }
  }
  return Array.from(source.slice(heading.start, end)).length;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}
