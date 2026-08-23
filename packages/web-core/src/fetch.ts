import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

import { renderMarkdown, truncateContent } from "./markdown.js";
import {
  boundedRequest,
  isOperationAborted,
  isRequestTimeout,
  readResponseBytes,
  throwIfAborted,
} from "./request.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_BINARY_SCAN_BYTES = 8192;
const WEB_FETCH_AGENT = "guionai-web/1.0";

export type FetchInput = {
  url: string;
  tree?: boolean;
  section_id?: string;
  full?: boolean;
  tree_threshold?: number;
};

export type FetchResult = {
  url: string;
  mode: "full" | "tree" | "section";
  content: string;
};

export interface FetchCache {
  prepare(): Promise<void>;
  read(url: string): Promise<string | undefined>;
  write(url: string, content: string, signal?: AbortSignal): Promise<void>;
}

export interface FetchOptions {
  /** Test-owned or application-owned cache root; omitted uses the platform default. */
  cacheDirectory?: string;
  /** Test-owned cache seam; omitted uses the Guion-owned daily disk cache. */
  cache?: FetchCache;
  /** Test-owned HTTP implementation; omitted uses Node's native fetch. */
  fetch?: typeof globalThis.fetch;
}

/** Fetches static HTML or text and renders the established Markdown navigation modes. */
export async function fetchWebPage(
  input: FetchInput,
  callerSignal?: AbortSignal,
  options?: FetchOptions,
): Promise<FetchResult> {
  const url = validateURL(input.url);
  const content = await fetchCached(url, callerSignal, options);
  throwIfAborted(callerSignal);
  const rendered = renderMarkdown(
    content,
    input.tree ?? false,
    input.section_id,
    input.full ?? false,
    input.tree_threshold,
  );
  return { url, mode: rendered.mode, content: rendered.content };
}

async function fetchCached(
  url: string,
  callerSignal: AbortSignal | undefined,
  options?: FetchOptions,
): Promise<string> {
  throwIfAborted(callerSignal);
  const cache =
    options?.cache ??
    new DailyCache(options?.cacheDirectory ?? defaultCacheDir());
  await cache.prepare();
  throwIfAborted(callerSignal);
  const cached = await cache.read(url);
  throwIfAborted(callerSignal);
  if (cached !== undefined) return cached;

  const content = await fetchLocal(url, callerSignal, options);
  throwIfAborted(callerSignal);
  await cache.write(url, content, callerSignal);
  throwIfAborted(callerSignal);
  return content;
}

async function fetchLocal(
  url: string,
  callerSignal?: AbortSignal,
  options?: FetchOptions,
): Promise<string> {
  throwIfAborted(callerSignal);
  const fetcher = options?.fetch ?? globalThis.fetch;
  try {
    return await boundedRequest(
      fetcher,
      url,
      {
        headers: { "User-Agent": WEB_FETCH_AGENT },
        redirect: "follow",
      },
      {
        callerSignal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        timeoutMessage: `fetch timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`,
      },
      async (response, signal) => {
        if (response.status >= 400) throw new Error(`HTTP ${response.status}`);

        const body = await readResponseBytes(
          response,
          MAX_DOWNLOAD_BYTES,
          signal,
        );
        throwIfAborted(callerSignal);
        const contentType = mediaType(response.headers.get("content-type"));
        if (isBinaryContentType(contentType) || isBinaryBody(body)) {
          throw binaryFetchError(
            url,
            response.headers.get("content-type") ?? "",
          );
        }

        if (contentType !== "" && contentType !== "text/html") {
          return truncateContent(new TextDecoder().decode(body));
        }

        try {
          const { document } = parseHTML(new TextDecoder().decode(body));
          const parsed = await Defuddle(document, url, {
            markdown: true,
            useAsync: false,
          });
          throwIfAborted(callerSignal);
          const content = parsed.content;
          if (!content || content.trim() === "")
            throw new Error("no content could be extracted");
          return truncateContent(
            content.endsWith("\n") ? content : content + "\n",
          );
        } catch (error) {
          throw new Error(`defuddle parse failed: ${errorMessage(error)}`);
        }
      },
    );
  } catch (error) {
    if (isOperationAborted(error) || isRequestTimeout(error)) throw error;
    if (
      error instanceof Error &&
      error.message.startsWith("binary content at ")
    )
      throw error;
    throw new Error(`fetch ${url}: ${errorMessage(error)}`);
  }
}

function validateURL(rawURL: string): string {
  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    throw new Error(`fetch ${rawURL}: invalid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`fetch ${rawURL}: URL must use http or https`);
  }
  return rawURL;
}

function mediaType(contentType: string | null): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isBinaryContentType(contentType: string): boolean {
  return [
    "application/octet-stream",
    "application/zip",
    "application/gzip",
    "application/x-gzip",
    "application/x-tar",
    "application/pdf",
    "application/msword",
    "application/vnd.ms-",
    "application/vnd.openxmlformats",
    "image/",
    "audio/",
    "video/",
    "font/",
    "application/x-msdownload",
    "application/x-executable",
    "application/x-mach-binary",
  ].some((prefix) => contentType.startsWith(prefix));
}

function isBinaryBody(body: Uint8Array): boolean {
  const limit = Math.min(body.byteLength, MAX_BINARY_SCAN_BYTES);
  for (let index = 0; index < limit; index++) {
    if (body[index] === 0) return true;
  }
  return false;
}

function binaryFetchError(url: string, contentType: string): Error {
  const displayType = contentType || "(none)";
  return new Error(
    `binary content at ${url} (Content-Type: ${displayType})\n\n` +
      "web fetch only handles text. Use curl to download:\n  curl -L -O " +
      url,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultCacheDir(): string {
  const home = process.env.HOME?.trim() || homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    const root = localAppData || join(home, "AppData", "Local");
    return join(root, "guionai", "web", "scrapes");
  }
  const root = process.env.XDG_CACHE_HOME?.trim() || join(home, ".cache");
  return join(root, "guionai", "web", "scrapes");
}

class DailyCache implements FetchCache {
  private enabled = false;

  constructor(private readonly directory: string) {}

  async prepare(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      this.enabled = true;
    } catch {
      this.enabled = false;
    }
  }

  async read(url: string): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    try {
      return await readFile(this.path(url), "utf8");
    } catch {
      return undefined;
    }
  }

  async write(
    url: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (!this.enabled) return;
    try {
      throwIfAborted(signal);
      await writeFile(this.path(url), content, {
        encoding: "utf8",
        mode: 0o644,
      });
    } catch {
      if (signal?.aborted) throwIfAborted(signal);
      // Cache failures must not make a successful direct fetch fail.
    }
  }

  private path(url: string): string {
    return join(this.directory, cacheFileName(url, new Date()));
  }
}

function cacheFileName(url: string, date: Date): string {
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) =>
      index === 0 ? String(part) : String(part).padStart(2, "0"),
    )
    .join("-");
  const key = createHash("sha256").update(url).digest("hex");
  return `${key}__${day}.md`;
}
