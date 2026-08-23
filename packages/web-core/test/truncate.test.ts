import { describe, expect, it } from "vitest";

import {
  formatSize,
  truncateHead,
  type TruncationResult,
} from "../src/index.js";

describe("shared model-facing truncation", () => {
  it("preserves line and UTF-8 byte limits, metadata, overflow, and sizes", () => {
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(1024 * 1024)).toBe("1.0MB");

    const byLines = truncateHead("one\ntwo\nthree", {
      maxLines: 2,
      maxBytes: 100,
    });
    expect(byLines).toMatchObject<Partial<TruncationResult>>({
      content: "one\ntwo",
      truncated: true,
      truncatedBy: "lines",
      totalLines: 3,
      totalBytes: 13,
      outputLines: 2,
      outputBytes: 7,
      firstLineExceedsLimit: false,
    });

    const byBytes = truncateHead("éé\na\nb", {
      maxLines: 10,
      maxBytes: 7,
    });
    expect(byBytes).toMatchObject<Partial<TruncationResult>>({
      content: "éé\na",
      truncated: true,
      truncatedBy: "bytes",
      totalBytes: 8,
      outputLines: 2,
      outputBytes: 6,
      firstLineExceedsLimit: false,
    });
    expect(Buffer.byteLength(byBytes.content, "utf8")).toBeLessThanOrEqual(7);

    const firstLineOverflow = truncateHead(`${"😀".repeat(3)}\nrest`, {
      maxLines: 10,
      maxBytes: 10,
    });
    expect(firstLineOverflow).toMatchObject<Partial<TruncationResult>>({
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines: 2,
      totalBytes: 17,
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
    });
  });
});
