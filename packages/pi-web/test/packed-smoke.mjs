import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "guionai-pi-web-pack-smoke-"));
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) throw new Error("pnpm entrypoint is unavailable");

async function pnpm(args, cwd) {
  return execFileAsync(process.execPath, [pnpmEntrypoint, ...args], {
    cwd,
    env: { ...process.env, npm_config_store_dir: join(root, "store"), npm_config_ignore_scripts: "true" },
  });
}

try {
  const packDirectory = join(root, "pack");
  await pnpm(["pack", "--pack-destination", packDirectory], packageRoot);
  const tarballs = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`expected one tarball, got ${tarballs.join(", ")}`);
  const tarball = join(packDirectory, tarballs[0]);

  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-web-pack-smoke", private: true }));
  await pnpm([
    "add", "--ignore-scripts", `file:${tarball}`,
    "@earendil-works/pi-ai@0.84.1",
    "@earendil-works/pi-coding-agent@0.84.1",
    "typebox@1.3.7",
  ], root);

  const packageDirectory = join(root, "node_modules", "@guionai", "pi-web");
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  if (JSON.stringify(manifest).includes("workspace:")) throw new Error("packed manifest contains workspace protocol");
  if (Object.keys(manifest.peerDependencies ?? {}).sort().join(",") !==
    "@earendil-works/pi-ai,@earendil-works/pi-coding-agent,typebox") {
    throw new Error("Pi, Pi AI, and TypeBox must be peer dependencies");
  }
  if (manifest.bin || manifest.dependencies || manifest.optionalDependencies || manifest.scripts?.preinstall || manifest.scripts?.install || manifest.scripts?.postinstall) {
    throw new Error("packed extension has a runtime dependency, optional native dependency, or install script");
  }

  const extension = await import(pathToFileURL(join(packageDirectory, "dist", "index.js")).href);
  const registered = [];
  extension.default({ registerTool: (tool) => registered.push(tool) });
  if (registered.map((tool) => tool.name).join(",") !== "web_search,web_fetch,web_docs,web_sgraph") {
    throw new Error("packed extension did not register exactly four web tools");
  }

  const originalFetch = globalThis.fetch;
  const originalHome = process.env.HOME;
  const originalCache = process.env.XDG_CACHE_HOME;
  const originalExaKey = process.env.EXA_API_KEY;
  process.env.HOME = join(root, "runtime-home");
  process.env.XDG_CACHE_HOME = join(root, "runtime-cache");
  process.env.EXA_API_KEY = "fixture-exa-key";
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === "https://api.exa.ai/search") {
      if (init.headers["x-api-key"] !== "fixture-exa-key" || JSON.parse(init.body).query !== "packed search") return new Response("bad search request", { status: 400 });
      return Response.json({ results: [{ title: "Packed search", url: "https://example.test/search", highlights: ["fixture"] }] });
    }
    if (target === "https://fixture.test/page") {
      return new Response("<article><h1>Packed page</h1><p>fixture content</p></article>", { headers: { "content-type": "text/html" } });
    }
    if (target.startsWith("https://context7.com/api/v1/search?")) {
      if (new URL(target).searchParams.get("query") !== "react") return new Response("bad docs query", { status: 400 });
      return Response.json({ results: [{ id: "/reactjs/react.dev", title: "React", description: "fixture", trustScore: 10, totalSnippets: 1 }] });
    }
    if (target === "https://context7.com/api/v1/reactjs/react.dev?type=txt&topic=hooks&tokens=50") return new Response("Packed documentation");
    if (target === "https://sourcegraph.com/.api/graphql") {
      if (JSON.parse(init.body).variables.query !== "packed source") return new Response("bad source query", { status: 400 });
      return Response.json({ data: { search: { results: { matchCount: 0, resultCount: 0, results: [] } } } });
    }
    throw new Error(`unexpected fixture URL ${target}`);
  };

  try {
    const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]));
    const search = await byName.web_search.execute("test", { queries: ["packed search"] });
    const fetched = await byName.web_fetch.execute("test", { url: "https://fixture.test/page", full: true });
    const resolve = await byName.web_docs.execute("test", { action: "resolve", query: "react" });
    const docs = await byName.web_docs.execute("test", { action: "fetch", library_id: "/reactjs/react.dev", topic: "hooks", tokens: 50 });
    const source = await byName.web_sgraph.execute("test", { query: "packed source" });
    if (search.details.results[0]?.title !== "Packed search" || !fetched.details.content.includes("fixture content") ||
      resolve.details.libraries[0]?.id !== "/reactjs/react.dev" || docs.details.content !== "Packed documentation" ||
      !source.details.content.includes("No results found")) {
      throw new Error("packed extension could not execute all tools against local fixtures");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = originalCache;
    if (originalExaKey === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = originalExaKey;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
