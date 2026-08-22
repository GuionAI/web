import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
        await expect(fetchPage({ url: `${url}/empty` })).rejects.toThrow(
          "no content could be extracted",
        );
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

  it("stops reading streamed bodies above 10 MiB", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("x".repeat(10 * 1024 * 1024 + 1));
    });
    try {
      await withTempCache(async (fetchPage) => {
        await expect(fetchPage({ url })).rejects.toThrow("10485760 byte limit");
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

  it("normalizes the 30-second request timeout without waiting", async () => {
    const cacheDirectory = mkdtempSync(join(tmpdir(), "guionai-web-timeout-"));
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        handler: (...args: never[]) => void,
        timeout?: number,
        ...args: never[]
      ) =>
        realSetTimeout(
          handler,
          timeout === 30_000 ? 0 : timeout,
          ...args,
        )) as unknown as typeof setTimeout);
    try {
      await expect(
        fetchWebPage({ url: "http://fixture.test/slow" }, undefined, {
          cacheDirectory,
          fetch: async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("timeout", "AbortError")),
              );
            }),
        }),
      ).rejects.toThrow("fetch timed out after 30 seconds");
    } finally {
      timeoutSpy.mockRestore();
      rmSync(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("normalizes cancellation before the request, during transport, and after cache access", async () => {
    const cacheDirectories = [
      mkdtempSync(join(tmpdir(), "guionai-web-abort-")),
      mkdtempSync(join(tmpdir(), "guionai-web-abort-")),
      mkdtempSync(join(tmpdir(), "guionai-web-cache-abort-")),
      mkdtempSync(join(tmpdir(), "guionai-web-body-abort-")),
    ];
    try {
      const before = new AbortController();
      before.abort();
      const noNetwork = vi.fn();
      await expect(
        fetchWebPage({ url: "http://fixture.test/page" }, before.signal, {
          cacheDirectory: cacheDirectories[0],
          fetch: noNetwork,
        }),
      ).rejects.toThrow("Operation aborted");
      expect(noNetwork).not.toHaveBeenCalled();

      const controller = new AbortController();
      let transportSawAbort = false;
      let startTransport: () => void;
      const transportStarted = new Promise<void>((resolve) => {
        startTransport = resolve;
      });
      const pending = fetchWebPage(
        { url: "http://fixture.test/slow" },
        controller.signal,
        {
          cacheDirectory: cacheDirectories[1],
          fetch: async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                transportSawAbort = true;
                reject(new DOMException("cancelled", "AbortError"));
              });
              startTransport!();
            }),
        },
      );
      await transportStarted;
      controller.abort();
      await expect(pending).rejects.toThrow("Operation aborted");
      expect(transportSawAbort).toBe(true);

      const bodyController = new AbortController();
      let bodySawCancel = false;
      let startReading: () => void;
      const bodyReadStarted = new Promise<void>((resolve) => {
        startReading = resolve;
      });
      let releasePull: () => void;
      const bodyPending = fetchWebPage(
        { url: "http://fixture.test/body" },
        bodyController.signal,
        {
          cacheDirectory: cacheDirectories[3],
          fetch: async () =>
            new Response(
              new ReadableStream({
                pull() {
                  startReading!();
                  return new Promise<void>((resolve) => {
                    releasePull = resolve;
                  });
                },
                cancel() {
                  bodySawCancel = true;
                  releasePull!();
                },
              }),
              { headers: { "Content-Type": "text/plain" } },
            ),
        },
      );
      await bodyReadStarted;
      bodyController.abort();
      await expect(bodyPending).rejects.toThrow("Operation aborted");
      expect(bodySawCancel).toBe(true);

      const cached = new AbortController();
      const noFetchAfterCacheRead = vi.fn();
      await expect(
        fetchWebPage({ url: "http://fixture.test/cached" }, cached.signal, {
          cacheDirectory: cacheDirectories[2],
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
