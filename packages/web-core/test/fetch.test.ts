import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { fetchWebPage } from "../src/index.js";

type FetchPage = typeof fetchWebPage;

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server did not bind");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function withTempCache<T>(
  fn: (fetchPage: FetchPage, cacheDirectory: string) => Promise<T>,
): Promise<T> {
  const cacheDirectory = mkdtempSync(
    join(tmpdir(), "guionai-web-fetch-cache-"),
  );
  const fetchPage: FetchPage = (input, signal) =>
    fetchWebPage(input, signal, { cacheDirectory });
  try {
    return await fn(fetchPage, cacheDirectory);
  } finally {
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe.sequential("browserless fetch migrated from Organon", () => {
  it("validates HTTP URLs and follows redirects", async () => {
    let requests = 0;
    const { server, url } = await startServer((req, res) => {
      requests++;
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/page" });
        res.end();
        return;
      }
      res.setHeader("Content-Type", "text/plain");
      res.end("redirected text");
    });
    try {
      await withTempCache(async (fetchPage) => {
        await expect(fetchPage({ url: "file:///tmp/page" })).rejects.toThrow(
          "URL must use http or https",
        );
        await expect(fetchPage({ url: "not a URL" })).rejects.toThrow(
          "invalid URL",
        );
        await expect(
          fetchPage({ url: `${url}/redirect`, full: true }),
        ).resolves.toMatchObject({
          content: "redirected text",
          mode: "full",
        });
        expect(requests).toBe(2);
      });
    } finally {
      await close(server);
    }
  });

  it("rejects HTTP failures but accepts a final 3xx response", async () => {
    let status = 399;
    const fakeFetch = vi.fn(
      async () =>
        new Response("status body", {
          status,
          headers: { "Content-Type": "text/plain" },
        }),
    ) as typeof fetch;
    await withTempCache(async (_fetchPage, cacheDirectory) => {
      await expect(
        fetchWebPage({ url: "http://status.test/399" }, undefined, {
          cacheDirectory,
          fetch: fakeFetch,
        }),
      ).resolves.toMatchObject({ content: "status body" });
      status = 400;
      await expect(
        fetchWebPage({ url: "http://status.test/400" }, undefined, {
          cacheDirectory,
          fetch: fakeFetch,
        }),
      ).rejects.toThrow("HTTP 400");
      status = 503;
      await expect(
        fetchWebPage({ url: "http://status.test/503" }, undefined, {
          cacheDirectory,
          fetch: fakeFetch,
        }),
      ).rejects.toThrow("HTTP 503");
    });
  });

  it("returns textual non-HTML bodies and extracts HTML through linkedom and Defuddle", async () => {
    const { server, url } = await startServer((req, res) => {
      if (req.url === "/text") {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("package main\n\nfunc main() {}\n");
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        "<html><body><article><p>Extracted text.</p></article></body></html>",
      );
    });
    try {
      await withTempCache(async (fetchPage) => {
        await expect(
          fetchPage({ url: `${url}/text`, full: true }),
        ).resolves.toMatchObject({
          content: "package main\n\nfunc main() {}\n",
        });
        await expect(fetchPage({ url, full: true })).resolves.toEqual({
          url,
          mode: "full",
          content: "Extracted text.\n",
        });
      });
    } finally {
      await close(server);
    }
  });

  it("rejects empty HTML extraction, known binary media, and NUL-bearing bodies", async () => {
    const { server, url } = await startServer((req, res) => {
      if (req.url === "/empty") {
        res.setHeader("Content-Type", "text/html");
        res.end("<html><body></body></html>");
      } else if (req.url === "/nul") {
        res.setHeader("Content-Type", "text/plain");
        res.end(Buffer.from([120, 0, 121]));
      } else {
        res.setHeader("Content-Type", "application/pdf");
        res.end("not actually a PDF");
      }
    });
    try {
      await withTempCache(async (fetchPage) => {
        await expect(fetchPage({ url: `${url}/empty` })).rejects.toMatchObject({
          code: "javascript_rendering_may_be_required",
          details: {
            retryableWithRender: true,
            suggestedArguments: { render: "agent-browser", waitMs: 2000 },
          },
        });
        await expect(fetchPage({ url })).rejects.toThrow(
          /binary content.*curl -L -O/s,
        );
        await expect(fetchPage({ url: `${url}/nul` })).rejects.toThrow(
          /binary content/,
        );
      });
    } finally {
      await close(server);
    }
  });

  it("uses daily URL-hash cache files, skips stale entries, and tolerates cache failures", async () => {
    let requests = 0;
    const { server, url } = await startServer((req, res) => {
      requests++;
      res.setHeader("Content-Type", "text/plain");
      res.end(`network ${req.url}`);
    });
    const cacheRoot = mkdtempSync(join(tmpdir(), "guionai-web-cache-failure-"));
    try {
      await withTempCache(async (fetchPage, cacheDirectory) => {
        const cachedURL = `${url}/cached`;
        await fetchPage({ url: cachedURL });
        await fetchPage({ url: cachedURL });
        expect(requests).toBe(1);

        const [file] = readdirSync(cacheDirectory);
        expect(file).toMatch(/^[0-9a-f]{64}__[0-9]{4}-[0-9]{2}-[0-9]{2}[.]md$/);
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const day = [
          yesterday.getFullYear(),
          yesterday.getMonth() + 1,
          yesterday.getDate(),
        ]
          .map((part, index) =>
            index === 0 ? String(part) : String(part).padStart(2, "0"),
          )
          .join("-");
        renameSync(
          join(cacheDirectory, file!),
          join(
            cacheDirectory,
            file!.replace(/__[0-9]{4}-[0-9]{2}-[0-9]{2}[.]md$/, `__${day}.md`),
          ),
        );
        await fetchPage({ url: cachedURL });
        expect(requests).toBe(2);

        const windowsSafeURL = `${url}/windows?value=%3C%3E%3A%22%7C%3F*`;
        await fetchPage({ url: windowsSafeURL });
        expect(
          readdirSync(cacheDirectory).every(
            (name) =>
              /^[0-9a-f]{64}__[0-9-]+[.]md$/.test(name) && name.length <= 80,
          ),
        ).toBe(true);
      });

      const cacheFile = join(cacheRoot, "not-a-directory");
      writeFileSync(cacheFile, "cache failure");
      await fetchWebPage({ url: `${url}/uncached` }, undefined, {
        cacheDirectory: cacheFile,
      });
      await fetchWebPage({ url: `${url}/uncached` }, undefined, {
        cacheDirectory: cacheFile,
      });
      expect(requests).toBe(5);

      const brokenDirectory = mkdtempSync(join(cacheRoot, "broken-"));
      await fetchWebPage({ url: `${url}/write-failure` }, undefined, {
        cacheDirectory: brokenDirectory,
      });
      const [cachedFile] = readdirSync(brokenDirectory);
      rmSync(join(brokenDirectory, cachedFile!), { force: true });
      mkdirSync(join(brokenDirectory, cachedFile!), { recursive: true });
      await fetchWebPage({ url: `${url}/write-failure` }, undefined, {
        cacheDirectory: brokenDirectory,
      });
      await fetchWebPage({ url: `${url}/write-failure` }, undefined, {
        cacheDirectory: brokenDirectory,
      });
      expect(requests).toBe(8);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      await close(server);
    }
  });

  it("normalizes cancellation after cache access", async () => {
    const cacheDirectories = [
      mkdtempSync(join(tmpdir(), "guionai-web-cache-abort-")),
    ];
    try {
      const cached = new AbortController();
      const noFetchAfterCacheRead = vi.fn();
      await expect(
        fetchWebPage({ url: "http://fixture.test/cached" }, cached.signal, {
          cacheDirectory: cacheDirectories[0],
          fetch: noFetchAfterCacheRead,
          cache: {
            prepare: async () => {},
            read: async () => {
              cached.abort();
              return "cached value";
            },
            write: async () => {},
          },
        }),
      ).rejects.toThrow("Operation aborted");
      expect(noFetchAfterCacheRead).not.toHaveBeenCalled();
    } finally {
      for (const directory of cacheDirectories)
        rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders only through an explicit, isolated agent-browser session", async () => {
    await withFakeAgentBrowser(async (logPath) => {
      const cacheDirectory = mkdtempSync(
        join(tmpdir(), "guionai-web-render-cache-"),
      );
      const resolveHost = async () => ["93.184.216.34"];
      const directFetch = vi.fn(
        async () =>
          new Response("<html><body><p>Direct content.</p></body></html>", {
            headers: { "content-type": "text/html" },
          }),
      ) as typeof fetch;
      try {
        await expect(
          fetchWebPage(
            { url: "https://render.test/page", render: "fetch" },
            undefined,
            { cacheDirectory, fetch: directFetch, resolveHost },
          ),
        ).resolves.toMatchObject({ content: "Direct content.\n" });
        expect(readFakeLog(logPath)).toEqual([]);
        await fetchWebPage({ url: "https://render.test/default" }, undefined, {
          cacheDirectory,
          fetch: directFetch,
          resolveHost,
        });
        expect(readFakeLog(logPath)).toEqual([]);

        await expect(
          fetchWebPage(
            {
              url: "https://render.test/page",
              render: "agent-browser",
              waitMs: 0,
              full: true,
            },
            undefined,
            { cacheDirectory, fetch: directFetch, resolveHost },
          ),
        ).resolves.toMatchObject({ content: "SPA\\_MARKER\\_RENDERED\n" });
        expect(directFetch).toHaveBeenCalledTimes(2);

        const first = readFakeLog(logPath);
        expect(first).toHaveLength(3);
        expect(first.map((entry) => command(entry.args))).toEqual([
          "open",
          "eval",
          "close",
        ]);
        const open = first[0]!;
        expect(open.args).toEqual(
          expect.arrayContaining([
            "--json",
            "--allowed-domains",
            "render.test,*.render.test,cdn.jsdelivr.net,unpkg.com,cdnjs.cloudflare.com,ajax.googleapis.com,fonts.googleapis.com,fonts.gstatic.com,esm.sh",
            "--idle-timeout",
            "10s",
            "open",
            "https://render.test/page",
          ]),
        );
        const session = optionValue(open.args, "--session");
        expect(session).toMatch(/^[0-9a-f-]{36}$/);
        expect(
          first.every(
            (entry) => optionValue(entry.args, "--session") === session,
          ),
        ).toBe(true);
        expect(open.cwd).not.toBe(process.cwd());
        expect(open.home).toContain("guionai-web-render-");
        expect(open.config).toBe("{}\n");
        expect(open.profile).toBeUndefined();

        await fetchWebPage(
          {
            url: "https://render.test/page",
            render: "agent-browser",
            waitMs: 1,
          },
          undefined,
          { cacheDirectory, fetch: directFetch, resolveHost },
        );
        expect(readFakeLog(logPath)).toHaveLength(6);
      } finally {
        rmSync(cacheDirectory, { recursive: true, force: true });
      }
    });
  });

  it("cancels the post-load wait and still closes the isolated session", async () => {
    await withFakeAgentBrowser(async (logPath) => {
      const controller = new AbortController();
      const pending = fetchWebPage(
        {
          url: "https://render.test/page",
          render: "agent-browser",
          waitMs: 30_000,
        },
        controller.signal,
        { resolveHost: async () => ["93.184.216.34"] },
      );
      await waitForFakeCommands(logPath, 1);
      controller.abort();
      await expect(pending).rejects.toThrow("Operation aborted");
      expect(readFakeLog(logPath).map((entry) => command(entry.args))).toEqual([
        "open",
        "close",
      ]);
    });
  });

  it("rejects unsafe rendered targets and maps allowlist gaps without launching a browser", async () => {
    await expect(
      fetchWebPage({
        url: "https://render.test/page",
        render: "agent-browser",
      }),
    ).rejects.toThrow("waitMs is required");
    await expect(
      fetchWebPage({ url: "https://render.test/page", waitMs: 0 }),
    ).rejects.toThrow("waitMs is only valid");
    await expect(
      fetchWebPage({
        url: "https://render.test/page",
        render: "agent-browser",
        waitMs: 30_001,
      }),
    ).rejects.toThrow("waitMs must be an integer");

    await withFakeAgentBrowser(async (logPath) => {
      const options = { resolveHost: async () => ["93.184.216.34"] };
      await expect(
        fetchWebPage({
          url: "http://127.0.0.1/private",
          render: "agent-browser",
          waitMs: 0,
        }),
      ).rejects.toThrow("private or reserved");
      expect(readFakeLog(logPath)).toEqual([]);

      await expect(
        fetchWebPage(
          {
            url: "https://blocked.test/page",
            render: "agent-browser",
            waitMs: 0,
          },
          undefined,
          options,
        ),
      ).rejects.toMatchObject({
        code: "render_domain_not_allowed",
        details: {
          retryable: false,
          reportUrl: "https://github.com/guionai/web/issues/new",
          blockedHostname: "missing.cdn.test",
        },
      });
      expect(readFakeLog(logPath).map((entry) => command(entry.args))).toEqual([
        "open",
        "close",
      ]);
    });
  });

  it("keeps client-only SPA script output unrendered", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<html><body><main><p>Initial static content.</p></main><script>document.querySelector('main').innerHTML = '<p>SPA_MARKER_RENDERED</p>'</script></body></html>",
      );
    });
    try {
      await withTempCache(async (fetchPage) => {
        const result = await fetchPage({ url, full: true });
        expect(result.content).toContain("Initial static content.");
        expect(result.content).not.toContain("SPA_MARKER_RENDERED");
      });
    } finally {
      await close(server);
    }
  });
});

async function withFakeAgentBrowser<T>(
  fn: (logPath: string) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(
    join(tmpdir(), "guionai-web-fake-agent-browser-"),
  );
  const executable = join(directory, "agent-browser");
  const logPath = join(directory, "commands.jsonl");
  const previousPath = process.env.PATH;
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const command = ["open", "eval", "close"].find((value) => args.includes(value));
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args,
  cwd: process.cwd(),
  home: process.env.HOME,
  config: readFileSync(process.env.AGENT_BROWSER_CONFIG, "utf8"),
  profile: process.env.AGENT_BROWSER_PROFILE,
}) + "\\n");
if (command === "open" && args.includes("https://blocked.test/page")) {
  console.log(JSON.stringify({ success: false, error: { message: "domain not allowed", hostname: "missing.cdn.test" } }));
  process.exit(1);
}
if (command === "eval") {
  console.log(JSON.stringify({ success: true, data: { result: "<html><body><main><p>SPA_MARKER_RENDERED</p></main></body></html>" } }));
} else {
  console.log(JSON.stringify({ success: true, data: {} }));
}
`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  process.env.PATH = `${directory}:${previousPath ?? ""}`;
  try {
    return await fn(logPath);
  } finally {
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

type FakeCommand = {
  args: string[];
  cwd: string;
  home?: string;
  config: string;
  profile?: string;
};

function readFakeLog(path: string): FakeCommand[] {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeCommand);
  } catch {
    return [];
  }
}

function command(args: string[]): string | undefined {
  return ["open", "eval", "close"].find((value) => args.includes(value));
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}

async function waitForFakeCommands(path: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (readFakeLog(path).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fake agent-browser command did not start");
}
