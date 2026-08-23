#!/usr/bin/env node
// Exercises tag-version synchronization in a disposable workspace.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const publicPackages = [
  { directory: "web", name: "@guionai/web" },
  { directory: "pi-web", name: "@guionai/pi-web" },
  { directory: "dsh-web", name: "@guionai/dsh-web" },
];
const workspace = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(fixture, script, version) {
  return execFileSync(process.execPath, [`scripts/${script}`, version], {
    cwd: fixture,
    encoding: "utf8",
    stdio: "pipe",
  });
}

function expectFailure(fixture, script, version, status) {
  try {
    run(fixture, script, version);
  } catch (error) {
    if (error.status === status) return;
    throw error;
  }
  throw new Error(`${script} accepted ${version}`);
}

const fixture = mkdtempSync(join(tmpdir(), "guionai-web-release-invariants-"));
try {
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  for (const { directory } of publicPackages) {
    const destination = join(fixture, "packages", directory);
    mkdirSync(destination, { recursive: true });
    copyFileSync(
      join(workspace, "packages", directory, "package.json"),
      join(destination, "package.json"),
    );
  }
  for (const script of ["sync-version.mjs", "release-dry-run.mjs"]) {
    copyFileSync(
      join(workspace, "scripts", script),
      join(fixture, "scripts", script),
    );
  }

  for (const version of ["0.0.0-test.1", "1.2.3"]) {
    run(fixture, "sync-version.mjs", version);
    run(fixture, "release-dry-run.mjs", version);
    for (const { directory, name } of publicPackages) {
      const manifest = JSON.parse(
        readFileSync(
          join(fixture, "packages", directory, "package.json"),
          "utf8",
        ),
      );
      if (manifest.name !== name || manifest.version !== version) {
        throw new Error(`${name} was not synchronized to ${version}`);
      }
    }
  }

  const repositoryManifestPath = join(
    fixture,
    "packages",
    "web",
    "package.json",
  );
  const repositoryManifest = JSON.parse(
    readFileSync(repositoryManifestPath, "utf8"),
  );
  repositoryManifest.repository.url = "git+https://github.com/guionai/web.git";
  writeFileSync(
    repositoryManifestPath,
    JSON.stringify(repositoryManifest) + "\n",
  );
  expectFailure(fixture, "release-dry-run.mjs", "1.2.3", 1);

  writeFileSync(
    join(fixture, "packages", "web", "package.json"),
    JSON.stringify({ name: "@guionai/web", version: "0.0.0" }) + "\n",
  );
  expectFailure(fixture, "release-dry-run.mjs", "1.2.3", 1);
  expectFailure(fixture, "sync-version.mjs", "v1.2.3", 2);

  console.log("release version synchronization fixtures passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
