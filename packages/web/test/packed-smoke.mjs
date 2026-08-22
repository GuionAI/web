import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "guionai-web-pack-smoke-"));
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) throw new Error("pnpm entrypoint is unavailable");

async function pnpm(args, cwd) {
  return execFileAsync(process.execPath, [pnpmEntrypoint, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: join(root, "home"),
      XDG_CACHE_HOME: join(root, "cache"),
      npm_config_store_dir: join(root, "store"),
      npm_config_ignore_scripts: "true",
    },
  });
}

const server = createServer((request, response) => {
  if (request.url === "/page") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<html><body><article><p>Packed fetch fixture.</p></article></body></html>");
    return;
  }
  if (request.url !== "/search") {
    response.statusCode = 404;
    response.end();
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.headers["x-api-key"] !== "fixture-key" || JSON.parse(body).query !== "packed fixture") {
      response.statusCode = 400;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ results: [{ title: "Packed result", url: "https://example.test", highlights: ["local fixture"] }] }));
  });
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const packDirectory = join(root, "pack");
  await pnpm(["pack", "--pack-destination", packDirectory], packageRoot);
  const tarballs = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`expected one tarball, got ${tarballs.join(", ")}`);
  const tarball = join(packDirectory, tarballs[0]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pack-smoke", private: true }));
  await pnpm(["add", "--offline", "--ignore-scripts", `file:${tarball}`], root);
  const installedManifest = JSON.parse(await readFile(join(root, "node_modules", "@guionai", "web", "package.json"), "utf8"));
  if (JSON.stringify(installedManifest).includes("workspace:")) throw new Error("packed manifest contains workspace protocol");

  const installed = await import(pathToFileURL(join(root, "node_modules", "@guionai", "web", "dist", "index.js")).href);
  const result = await installed.search({
    query: "packed fixture",
    credentials: { exaApiKey: "fixture-key" },
    endpoints: { exa: `http://127.0.0.1:${port}` },
  });
  if (result.provider !== "Exa" || result.results[0]?.title !== "Packed result") {
    throw new Error("installed package could not search the local fixture");
  }

  const binary = join(root, "node_modules", ".bin", "web");
  const { stdout } = await execFileAsync(binary, ["--help"], { cwd: root });
  if (!stdout.includes("Search the web")) throw new Error("installed web CLI did not start");

  const fetched = await execFileAsync(binary, ["fetch", `http://127.0.0.1:${port}/page`, "--full", "--json"], { cwd: root });
  const fetchedResult = JSON.parse(fetched.stdout);
  if (fetchedResult.mode !== "full" || fetchedResult.content !== "Packed fetch fixture.\n") {
    throw new Error("installed web CLI could not fetch the local fixture");
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
