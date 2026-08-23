import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatSize,
  truncateHead,
  type TruncationResult,
} from "@guionai/web-core";

type TruncateOptions = {
  hint?: string;
};

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
