import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

export type TruncationResult = {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
};

type TruncateOptions = {
  hint?: string;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateHead(content: string): TruncationResult {
  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = content.length === 0 ? [] : content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  const totalLines = lines.length;
  if (totalLines <= DEFAULT_MAX_LINES && totalBytes <= DEFAULT_MAX_BYTES) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    };
  }

  if (Buffer.byteLength(lines[0] ?? "", "utf8") > DEFAULT_MAX_BYTES) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (
    let index = 0;
    index < lines.length && index < DEFAULT_MAX_LINES;
    index += 1
  ) {
    const line = lines[index]!;
    const lineBytes = Buffer.byteLength(line, "utf8") + (index > 0 ? 1 : 0);
    if (outputBytes + lineBytes > DEFAULT_MAX_BYTES) {
      truncatedBy = "bytes";
      break;
    }
    outputLines.push(line);
    outputBytes += lineBytes;
  }

  const output = outputLines.join("\n");
  return {
    content: output,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes: Buffer.byteLength(output, "utf8"),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  };
}

/** Bounds model-facing text while retaining complete structured domain details. */
export async function modelTextResult<T extends object>(
  data: T,
  content: string,
  options?: TruncateOptions,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: T | (T & { truncation: TruncationResult; fullOutputPath: string });
}> {
  const truncation = truncateHead(content);
  if (!truncation.truncated)
    return { content: [{ type: "text", text: content }], details: data };

  const directory = await mkdtemp(join(tmpdir(), "pi-tool-output-"));
  const fullOutputPath = join(directory, "output.txt");
  await writeFile(fullOutputPath, content, { encoding: "utf8", mode: 0o600 });
  const hint = options?.hint?.trim() ? ` ${options.hint.trim()}` : "";
  const text = truncation.firstLineExceedsLimit
    ? `[First line is ${formatSize(truncation.totalBytes)}, exceeds ${formatSize(truncation.maxBytes)} limit.${hint} Full output saved to: ${fullOutputPath}]`
    : truncation.truncatedBy === "lines"
      ? `${truncation.content}\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines} line limit).${hint} Full output saved to: ${fullOutputPath}]`
      : `${truncation.content}\n\n[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes)} limit).${hint} Full output saved to: ${fullOutputPath}]`;
  return {
    content: [{ type: "text", text }],
    details: { ...data, truncation, fullOutputPath },
  };
}
