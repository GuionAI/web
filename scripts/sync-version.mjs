#!/usr/bin/env node
// Syncs a tag-derived release version across the three public package manifests.
// Usage: node scripts/sync-version.mjs <version> [--dry-run]
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const publicPackages = [
  { directory: "web", name: "@guionai/web" },
  { directory: "pi-web", name: "@guionai/pi-web" },
  { directory: "dsh-web", name: "@guionai/dsh-web" },
];
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const workspace = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (typeof version !== "string" || !semver.test(version)) {
  console.error("usage: node scripts/sync-version.mjs <x.y.z> [--dry-run]");
  process.exit(2);
}

for (const { directory, name } of publicPackages) {
  const manifestPath = join(workspace, "packages", directory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== name || manifest.private === true) {
    throw new Error(`${manifestPath} is not the public ${name} package`);
  }

  const before = JSON.stringify(manifest, null, 2);
  manifest.version = version;
  const after = JSON.stringify(manifest, null, 2);
  if (before !== after) {
    console.log(
      `${dryRun ? "[dry-run] would sync " : "synced "}${manifest.name} -> ${version}`,
    );
    if (!dryRun) writeFileSync(manifestPath, after + "\n");
  }
}

console.log(
  `${dryRun ? "[dry-run] " : ""}${publicPackages.length} manifests match version ${version}`,
);
