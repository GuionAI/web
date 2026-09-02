import { randomUUID, createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

import { renderMarkdown } from "./markdown.js";
import {
  boundedRequest,
  isOperationAborted,
  isRequestTimeout,
  OperationAbortedError,
  readResponseBytes,
  throwIfAborted,
} from "./request.js";

const REQUEST_TIMEOUT_MS = 30_000;
const RENDER_OPEN_TIMEOUT_MS = 30_000;
const RENDER_CAPTURE_TIMEOUT_MS = 5_000;
const RENDER_CLEANUP_TIMEOUT_MS = 5_000;
const RENDER_TERMINATION_GRACE_MS = 250;
const RENDER_IDLE_TIMEOUT = "10s";
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_BROWSER_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_BROWSER_STDERR_BYTES = 64 * 1024;
const MAX_BINARY_SCAN_BYTES = 8192;
const WEB_FETCH_AGENT = "guionai-web/1.0";
export const DEFAULT_LINK_LIMIT = 100;
export const MAX_LINK_LIMIT = 100;
export const RENDER_REPORT_URL = "https://github.com/guionai/web/issues/new";
export const RENDER_CDN_ALLOWLIST = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "ajax.googleapis.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "esm.sh",
] as const;

export type FetchInput = {
  url: string;
  section_id?: string;
  full?: boolean;
  render?: "http" | "browser";
  waitMs?: number;
};

export type FetchResult = {
  url: string;
  mode: "full" | "tree" | "section";
  content: string;
};

export type LinksInput = {
  url: string;
  limit?: number;
  render?: "http" | "browser";
  waitMs?: number;
};

export type PageLink = {
  text: string;
  url: string;
};

export type LinksResult = {
  url: string;
  links: PageLink[];
  truncated: boolean;
};

export type FetchErrorDetails = {
  retryableWithRender?: boolean;
  suggestedArguments?: { render: "browser"; waitMs: 2000 };
  retryable?: boolean;
  reportUrl?: string;
  blockedHostname?: string;
};

/** A stable fetch failure that host adapters can expose without parsing prose. */
export class FetchCapabilityError extends Error {
  constructor(
    readonly code: string,
    readonly details: FetchErrorDetails = {},
  ) {
    super(code);
    this.name = "FetchCapabilityError";
  }
}

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
  /** Test seam for public-target DNS validation; production uses system DNS. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Receives non-fatal renderer cleanup diagnostics. */
  onRendererDiagnostic?: (message: string) => void;
  /** Test seam for bounded removal of the renderer-owned temporary directory. */
  removeWorkDirectory?: (path: string) => Promise<void>;
  /** Test-only override for the renderer cleanup allowance. */
  rendererCleanupTimeoutMs?: number;
}

/** Fetches static HTML or explicit browser-rendered DOM as established Markdown navigation modes. */
export async function fetchWebPage(
  input: FetchInput,
  callerSignal?: AbortSignal,
  options?: FetchOptions,
): Promise<FetchResult> {
  validateFetchFields(input);
  const url = validateURL(input.url);
  const render = validateRenderInput(input);
  validateNavigationInput(input);
  const content =
    render === "browser"
      ? await renderPage(url, input.waitMs!, callerSignal, options)
      : await fetchCached(url, callerSignal, options);
  throwIfAborted(callerSignal);
  const rendered = renderMarkdown(content, {
    section_id: input.section_id,
    full: input.full === true,
  });
  return { url, mode: rendered.mode, content: rendered.content };
}

/** Lists HTTP(S) links from the original or browser-rendered page DOM. */
export async function fetchWebLinks(
  input: LinksInput,
  callerSignal?: AbortSignal,
  options?: FetchOptions,
): Promise<LinksResult> {
  validateLinksFields(input);
  const url = validateURL(input.url);
  const render = validateRenderInput(input);
  const limit = validateLinkLimit(input.limit);
  const source =
    render === "browser"
      ? await renderPageHTML(url, input.waitMs!, callerSignal, options)
      : await fetchPageHTML(url, callerSignal, options);
  throwIfAborted(callerSignal);
  return listPageLinks(source.html, source.url, url, limit);
}

function validateRenderInput(
  input: Pick<FetchInput, "render" | "waitMs">,
): "http" | "browser" {
  const render = input.render ?? "http";
  if (render !== "http" && render !== "browser")
    throw new Error('render must be "http" or "browser"');
  if (render === "http") {
    if (input.waitMs !== undefined)
      throw new Error("waitMs is only valid with render browser");
    return render;
  }
  if (input.waitMs === undefined)
    throw new Error("waitMs is required with render browser");
  if (
    !Number.isInteger(input.waitMs) ||
    input.waitMs < 0 ||
    input.waitMs > 30_000
  )
    throw new Error("waitMs must be an integer from 0 through 30000");
  return render;
}

function validateFetchFields(input: FetchInput): void {
  validateKnownFields(
    input,
    ["url", "section_id", "full", "render", "waitMs"],
    "fetch",
  );
  if (typeof input.full !== "undefined" && typeof input.full !== "boolean")
    throw new Error("full must be a boolean");
  if (typeof input.section_id !== "undefined") {
    if (typeof input.section_id !== "string" || input.section_id.trim() === "")
      throw new Error("section_id must be a non-empty string");
  }
}

function validateLinksFields(input: LinksInput): void {
  validateKnownFields(input, ["url", "limit", "render", "waitMs"], "links");
}

function validateKnownFields(
  input: object,
  fields: readonly string[],
  operation: string,
): void {
  for (const field of Object.keys(input)) {
    if (!fields.includes(field))
      throw new Error(`${operation} input does not accept field ${field}`);
  }
}

function validateNavigationInput(
  input: Pick<FetchInput, "section_id" | "full">,
): void {
  if (input.full === true && input.section_id !== undefined)
    throw new Error("full and section_id cannot be used together");
}

function validateLinkLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LINK_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LINK_LIMIT)
    throw new Error(
      `limit must be an integer from 1 through ${MAX_LINK_LIMIT}`,
    );
  return limit;
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
  try {
    const response = await downloadPage(url, callerSignal, options);
    if (response.contentType !== "" && response.contentType !== "text/html")
      return new TextDecoder().decode(response.body);
    return extractHTML(
      new TextDecoder().decode(response.body),
      url,
      callerSignal,
      true,
    );
  } catch (error) {
    if (
      isOperationAborted(error) ||
      isRequestTimeout(error) ||
      error instanceof FetchCapabilityError ||
      (error instanceof Error &&
        (error.message.startsWith("binary content at ") ||
          error.message.startsWith(`fetch ${url}:`)))
    )
      throw error;
    throw new Error(`fetch ${url}: ${errorMessage(error)}`);
  }
}

type DownloadedPage = {
  body: Uint8Array;
  contentType: string;
  url: string;
};

type PageHTML = {
  html: string;
  url: string;
};

async function fetchPageHTML(
  url: string,
  callerSignal: AbortSignal | undefined,
  options: FetchOptions | undefined,
): Promise<PageHTML> {
  const response = await downloadPage(url, callerSignal, options);
  if (response.contentType !== "" && response.contentType !== "text/html")
    throw new Error(`links ${url}: page is not HTML`);
  return { html: new TextDecoder().decode(response.body), url: response.url };
}

async function downloadPage(
  url: string,
  callerSignal: AbortSignal | undefined,
  options: FetchOptions | undefined,
): Promise<DownloadedPage> {
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
        return { body, contentType, url: response.url || url };
      },
    );
  } catch (error) {
    if (
      isOperationAborted(error) ||
      isRequestTimeout(error) ||
      error instanceof FetchCapabilityError
    )
      throw error;
    if (
      error instanceof Error &&
      error.message.startsWith("binary content at ")
    )
      throw error;
    throw new Error(`fetch ${url}: ${errorMessage(error)}`);
  }
}

async function validateRenderTarget(
  url: string,
  callerSignal: AbortSignal | undefined,
  options: FetchOptions | undefined,
): Promise<URL> {
  const target = new URL(url);
  if (target.username || target.password)
    throw new Error(
      "render target URL must not include a username or password",
    );
  await validatePublicTarget(target, callerSignal, options);
  throwIfAborted(callerSignal);
  return target;
}

async function renderPage(
  url: string,
  waitMs: number,
  callerSignal: AbortSignal | undefined,
  options: FetchOptions | undefined,
): Promise<string> {
  const target = await validateRenderTarget(url, callerSignal, options);
  try {
    const page = await renderPageHTML(
      url,
      waitMs,
      callerSignal,
      options,
      target,
    );
    return await extractHTML(page.html, url, callerSignal, false);
  } catch (error) {
    throw rendererFailure(error);
  }
}

async function renderPageHTML(
  url: string,
  waitMs: number,
  callerSignal: AbortSignal | undefined,
  options: FetchOptions | undefined,
  target?: URL,
): Promise<PageHTML> {
  const renderTarget =
    target ?? (await validateRenderTarget(url, callerSignal, options));
  const workDirectory = await mkdtemp(join(tmpdir(), "guionai-web-render-"));
  const configPath = join(workDirectory, "agent-browser.json");
  const session = randomUUID();
  const environment = rendererEnvironment(workDirectory, configPath);
  const commonArgs = [
    "--session",
    session,
    "--json",
    "--config",
    configPath,
    "--allowed-domains",
    renderAllowlist(renderTarget.hostname).join(","),
    "--idle-timeout",
    RENDER_IDLE_TIMEOUT,
  ];
  let commandAttempted = false;

  try {
    await writeFile(configPath, "{}\n", { encoding: "utf8", mode: 0o600 });
    commandAttempted = true;
    const opened = await runAgentBrowser(
      [...commonArgs, "open", url],
      environment,
      workDirectory,
      callerSignal,
      RENDER_OPEN_TIMEOUT_MS,
    );
    assertCommandSuccess(opened.stdout);
    await waitForRender(waitMs, callerSignal);
    const capture = await runAgentBrowser(
      [
        ...commonArgs,
        "eval",
        "JSON.stringify({html: document.documentElement.outerHTML, url: document.location.href})",
      ],
      environment,
      workDirectory,
      callerSignal,
      RENDER_CAPTURE_TIMEOUT_MS,
    );
    return parseCapturedPage(capture.stdout, url);
  } catch (error) {
    throw rendererFailure(error);
  } finally {
    await cleanupRenderer(
      commandAttempted,
      commonArgs,
      environment,
      workDirectory,
      options,
    );
  }
}

function listPageLinks(
  html: string,
  sourceURL: string,
  resultURL: string,
  limit: number,
): LinksResult {
  const { document } = parseHTML(html);
  const baseURL = resolveDocumentBaseURL(document, sourceURL);
  const links: PageLink[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const anchor of document.querySelectorAll("a[href]")) {
    const url = resolvePageLink(anchor.getAttribute("href"), baseURL);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    if (links.length >= limit) {
      truncated = true;
      continue;
    }
    links.push({ text: pageLinkText(anchor), url });
  }
  return { url: resultURL, links, truncated };
}

function resolveDocumentBaseURL(document: Document, sourceURL: string): string {
  const href = document.querySelector("base[href]")?.getAttribute("href");
  if (!href) return sourceURL;
  try {
    return new URL(href, sourceURL).href;
  } catch {
    return sourceURL;
  }
}

function resolvePageLink(
  href: string | null,
  baseURL: string,
): string | undefined {
  if (!href || href.trim() === "") return undefined;
  try {
    const url = new URL(href, baseURL);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function pageLinkText(anchor: Element): string {
  const text = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) return text;
  return (
    anchor.getAttribute("aria-label") ??
    anchor.getAttribute("title") ??
    ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

async function cleanupRenderer(
  commandAttempted: boolean,
  commonArgs: string[],
  environment: NodeJS.ProcessEnv,
  workDirectory: string,
  options: FetchOptions | undefined,
): Promise<void> {
  const cleanupTimeoutMs =
    options?.rendererCleanupTimeoutMs ?? RENDER_CLEANUP_TIMEOUT_MS;
  const deadline = Date.now() + cleanupTimeoutMs;
  if (commandAttempted) {
    try {
      await runAgentBrowser(
        [...commonArgs, "close"],
        environment,
        workDirectory,
        undefined,
        Math.max(1, deadline - Date.now() - RENDER_TERMINATION_GRACE_MS),
      );
    } catch {
      options?.onRendererDiagnostic?.("agent-browser session close failed");
    }
  }

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    options?.onRendererDiagnostic?.(
      "agent-browser temporary directory cleanup timed out",
    );
    return;
  }
  const removeDirectory =
    options?.removeWorkDirectory ??
    ((directory: string) => rm(directory, { recursive: true, force: true }));
  try {
    await withCleanupTimeout(removeDirectory(workDirectory), remainingMs);
  } catch (error) {
    options?.onRendererDiagnostic?.(
      error instanceof CleanupTimeoutError
        ? "agent-browser temporary directory cleanup timed out"
        : "agent-browser temporary directory cleanup failed",
    );
  }
}

class CleanupTimeoutError extends Error {}

function withCleanupTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new CleanupTimeoutError());
    }, timeoutMs);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function extractHTML(
  html: string,
  url: string,
  callerSignal: AbortSignal | undefined,
  suggestRender: boolean,
): Promise<string> {
  try {
    const { document } = parseHTML(html);
    const parsed = await Defuddle(document, url, {
      markdown: true,
      useAsync: false,
    });
    throwIfAborted(callerSignal);
    const content = parsed.content;
    if (
      !content ||
      content.trim() === "" ||
      (suggestRender && isJavaScriptPlaceholder(content))
    ) {
      if (suggestRender) {
        throw new FetchCapabilityError("javascript_rendering_may_be_required", {
          retryableWithRender: true,
          suggestedArguments: { render: "browser", waitMs: 2000 },
        });
      }
      throw new Error("no content could be extracted");
    }
    return ensureTrailingNewline(content);
  } catch (error) {
    if (error instanceof FetchCapabilityError) throw error;
    throw new Error(`defuddle parse failed: ${errorMessage(error)}`);
  }
}

async function validatePublicTarget(
  url: URL,
  callerSignal: AbortSignal | undefined,
  options?: FetchOptions,
): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname))
      throw new Error(
        "render target must not use a private or reserved address",
      );
    return;
  }

  let addresses: string[];
  try {
    addresses = await awaitWithAbort(
      options?.resolveHost
        ? options.resolveHost(hostname)
        : lookup(hostname, { all: true, verbatim: true }).then((results) =>
            results.map(({ address }) => address),
          ),
      callerSignal,
    );
  } catch (error) {
    if (isOperationAborted(error)) throw error;
    throw new Error("render target DNS resolution failed");
  }
  throwIfAborted(callerSignal);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("render target must not use a private or reserved address");
  }
}

function renderAllowlist(hostname: string): string[] {
  const target = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return [target, `*.${target}`, ...RENDER_CDN_ALLOWLIST];
}

function rendererEnvironment(
  workDirectory: string,
  configPath: string,
): NodeJS.ProcessEnv {
  // Omit HOME rather than replacing it: agent-browser falls back to the host
  // account to locate its installed Chrome runtime. A unique session without a
  // profile or restore input still gives each render a fresh browser state.
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: workDirectory,
    TMP: workDirectory,
    TEMP: workDirectory,
    AGENT_BROWSER_CONFIG: configPath,
  };
  if (process.env.AGENT_BROWSER_EXECUTABLE_PATH !== undefined)
    environment.AGENT_BROWSER_EXECUTABLE_PATH =
      process.env.AGENT_BROWSER_EXECUTABLE_PATH;
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

type BrowserCommandResult = { stdout: string; stderr: string };
type RendererCommandFailure =
  | "aborted"
  | "timeout"
  | "output_limit"
  | "unavailable"
  | "failed";

class RendererCommandError extends Error {
  constructor(
    readonly kind: RendererCommandFailure,
    readonly stdout = "",
    readonly stderr = "",
  ) {
    super(`agent-browser command ${kind}`);
  }
}

function runAgentBrowser(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<BrowserCommandResult> {
  return new Promise((resolve, reject) => {
    let stdout: Buffer[] = [];
    let stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: RendererCommandFailure | undefined;
    let spawnError: NodeJS.ErrnoException | undefined;
    let settled = false;
    const child = spawn("agent-browser", args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      callerSignal?.removeEventListener("abort", abort);
      callback();
    };
    const stop = (reason: RendererCommandFailure) => {
      if (failure) return;
      failure = reason;
      child.kill("SIGTERM");
      forceKill = setTimeout(
        () => child.kill("SIGKILL"),
        RENDER_TERMINATION_GRACE_MS,
      );
    };
    const abort = () => stop("aborted");
    const timeout = setTimeout(() => stop("timeout"), timeoutMs);
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    callerSignal?.addEventListener("abort", abort, { once: true });
    if (callerSignal?.aborted) abort();

    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const max =
        stream === "stdout"
          ? MAX_BROWSER_STDOUT_BYTES
          : MAX_BROWSER_STDERR_BYTES;
      const size = stream === "stdout" ? stdoutBytes : stderrBytes;
      if (size + chunk.byteLength > max) {
        stop("output_limit");
        return;
      }
      if (stream === "stdout") {
        stdout.push(chunk);
        stdoutBytes += chunk.byteLength;
      } else {
        stderr.push(chunk);
        stderrBytes += chunk.byteLength;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (callerSignal?.aborted || failure === "aborted") {
        finish(() => reject(new RendererCommandError("aborted")));
      } else if (failure) {
        const reason = failure;
        finish(() =>
          reject(
            new RendererCommandError(reason, output.stdout, output.stderr),
          ),
        );
      } else if (spawnError) {
        const error = spawnError;
        finish(() =>
          reject(
            new RendererCommandError(
              error.code === "ENOENT" ? "unavailable" : "failed",
              output.stdout,
              output.stderr,
            ),
          ),
        );
      } else if (code !== 0) {
        finish(() =>
          reject(
            new RendererCommandError("failed", output.stdout, output.stderr),
          ),
        );
      } else {
        finish(() => resolve(output));
      }
    });
  });
}

function parseCapturedPage(stdout: string, fallbackURL: string): PageHTML {
  const record = parseSuccessEnvelope(stdout);
  const data = record.data;
  if (
    record.success !== true ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof (data as Record<string, unknown>).result !== "string"
  ) {
    throw new FetchCapabilityError("render_capture_failed");
  }
  try {
    const page = JSON.parse(
      (data as Record<string, unknown>).result as string,
    ) as unknown;
    if (!page || typeof page !== "object" || Array.isArray(page))
      throw new Error("invalid rendered page");
    const { html, url } = page as Record<string, unknown>;
    if (typeof html !== "string" || typeof url !== "string")
      throw new Error("invalid rendered page");
    return { html, url: renderedPageURL(url, fallbackURL) };
  } catch {
    throw new FetchCapabilityError("render_capture_failed");
  }
}

function renderedPageURL(url: string, fallbackURL: string): string {
  try {
    const value = new URL(url);
    return value.protocol === "http:" || value.protocol === "https:"
      ? value.href
      : fallbackURL;
  } catch {
    return fallbackURL;
  }
}

function assertCommandSuccess(stdout: string): void {
  parseSuccessEnvelope(stdout);
}

function parseSuccessEnvelope(stdout: string): Record<string, unknown> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new FetchCapabilityError("render_invalid_output");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    throw new FetchCapabilityError("render_invalid_output");
  const record = envelope as Record<string, unknown>;
  if (record.success !== true)
    throw new FetchCapabilityError("render_capture_failed");
  return record;
}

function rendererFailure(error: unknown): Error {
  if (isOperationAborted(error)) return error as Error;
  if (error instanceof FetchCapabilityError) return error;
  if (!(error instanceof RendererCommandError))
    return new FetchCapabilityError("render_failed");
  if (error.kind === "aborted") return new OperationAbortedError();
  if (isDomainAllowlistFailure(error)) {
    const blockedHost = blockedHostname(error.stdout, error.stderr);
    return new FetchCapabilityError("render_domain_not_allowed", {
      retryable: false,
      reportUrl: RENDER_REPORT_URL,
      ...(blockedHost ? { blockedHostname: blockedHost } : {}),
    });
  }
  const code =
    error.kind === "unavailable"
      ? "render_unavailable"
      : error.kind === "timeout"
        ? "render_timed_out"
        : error.kind === "output_limit"
          ? "render_output_too_large"
          : "render_failed";
  return new FetchCapabilityError(code);
}

function isDomainAllowlistFailure(error: RendererCommandError): boolean {
  const output = `${error.stdout}\n${error.stderr}`.toLowerCase();
  return output.includes("domain") && output.includes("allow");
}

function blockedHostname(stdout: string, stderr: string): string | undefined {
  const output = `${stdout}\n${stderr}`;
  const jsonHostname = hostnameFromJson(stdout) ?? hostnameFromJson(stderr);
  if (jsonHostname) return jsonHostname;
  const match = [
    /(?:not\s+allowed|blocked|rejected)\s*[:=-]?\s*["']?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)["']?/i,
    /(?:domain|hostname|host)\s*[:=-]?\s*["']?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)["']?\s+(?:is\s+)?(?:not\s+allowed|blocked|rejected)/i,
  ]
    .map((pattern) => output.match(pattern)?.[1])
    .find(
      (candidate): candidate is string =>
        candidate !== undefined && isValidHostname(candidate),
    );
  return match?.toLowerCase();
}

function hostnameFromJson(value: string): string | undefined {
  try {
    const envelope = JSON.parse(value);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
      return undefined;
    const record = envelope as Record<string, unknown>;
    return findHostname(record.error) ?? findHostname(record.errors);
  } catch {
    return undefined;
  }
}

function findHostname(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hostname = findHostname(item);
      if (hostname) return hostname;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["hostname", "host", "domain"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && isValidHostname(candidate))
      return candidate.toLowerCase();
  }
  for (const candidate of Object.values(record)) {
    const hostname = findHostname(candidate);
    if (hostname) return hostname;
  }
  return undefined;
}

function isValidHostname(value: string): boolean {
  if (value.length > 253 || value.includes("..")) return false;
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value);
}

function awaitWithAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new OperationAbortedError());
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function waitForRender(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new OperationAbortedError());
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
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

function isJavaScriptPlaceholder(content: string): boolean {
  const normalized = content.trim().replace(/\s+/g, " ").toLowerCase();
  return (
    normalized === "loading..." ||
    normalized === "loading…" ||
    normalized === "please enable javascript to continue." ||
    normalized === "please enable javascript to continue"
  );
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first! >= 224 ||
      (first === 100 && second! >= 64 && second! <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second! >= 16 && second! <= 31) ||
      (first === 192 && (second === 0 || second === 88 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0)
    );
  }
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  const groups = ipv6Groups(normalized);
  if (
    groups &&
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0 || groups[5] === 0xffff)
  ) {
    const embeddedIPv4 = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return isPrivateAddress(embeddedIPv4);
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("2001:db8:") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

function ipv6Groups(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const parse = (value: string): number[] | undefined => {
    if (value === "") return [];
    const groups: number[] = [];
    for (const part of value.split(":")) {
      if (isIP(part) === 4) {
        const octets = part.split(".").map(Number);
        groups.push((octets[0]! << 8) | octets[1]!);
        groups.push((octets[2]! << 8) | octets[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        groups.push(Number.parseInt(part, 16));
      } else {
        return undefined;
      }
    }
    return groups;
  };
  const left = parse(halves[0]!);
  const right = parse(halves[1] ?? "");
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const omitted = 8 - left.length - right.length;
  return omitted < 1
    ? undefined
    : [...left, ...Array(omitted).fill(0), ...right];
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

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
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
      // Cache failures must not make a successful HTTP fetch fail.
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
