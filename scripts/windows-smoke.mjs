#!/usr/bin/env node
// Focused Windows CI smoke: install the packed CLI, run it, and prove cache
// files use LOCALAPPDATA rather than a Unix-only path. On other hosts it is a
// deliberate no-op so the command remains safe for local verification.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (process.platform !== "win32") {
  console.log("Windows smoke skipped on non-Windows host");
  process.exit(0);
}

const execFileAsync = promisify(execFile);
const workspace = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(workspace, "packages", "web");
const root = await mkdtemp(join(tmpdir(), "guionai-web-windows-smoke-"));
const localAppData = join(root, "local-app-data");
const env = {
  ...process.env,
  HOME: join(root, "home"),
  LOCALAPPDATA: localAppData,
  XDG_CACHE_HOME: join(root, "unexpected-xdg-cache"),
  npm_config_store_dir: join(root, "store"),
  npm_config_ignore_scripts: "true",
};

const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end("<article><p>Windows packed cache fixture.</p></article>");
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const pack = join(root, "pack");
  await execFileAsync("pnpm", ["pack", "--pack-destination", pack], {
    cwd: packageRoot,
    env,
  });
  const tarballs = (await readdir(pack)).filter((file) =>
    file.endsWith(".tgz"),
  );
  if (tarballs.length !== 1) throw new Error("expected one packed web tarball");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "windows-web-smoke", private: true }),
  );
  await execFileAsync(
    "pnpm",
    ["add", "--offline", "--ignore-scripts", `file:${join(pack, tarballs[0])}`],
    {
      cwd: root,
      env,
    },
  );
  const binary = join(root, "node_modules", ".bin", "web.cmd");
  const { stdout } = await execFileAsync(
    binary,
    ["fetch", `http://127.0.0.1:${port}/page`, "--full", "--json"],
    {
      cwd: root,
      env,
    },
  );
  if (JSON.parse(stdout).content !== "Windows packed cache fixture.\n") {
    throw new Error("packed Windows CLI did not fetch the local fixture");
  }
  const cacheDirectory = join(localAppData, "guionai", "web", "scrapes");
  if ((await readdir(cacheDirectory)).length === 0) {
    throw new Error(
      "packed Windows CLI did not write to the LOCALAPPDATA cache path",
    );
  }
  console.log("Windows packed CLI install and LOCALAPPDATA cache smoke passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
