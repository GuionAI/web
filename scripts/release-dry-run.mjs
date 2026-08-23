#!/usr/bin/env node
// Verifies synchronized public package versions without network access.
// Usage: node scripts/release-dry-run.mjs <x.y.z>
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const publicPackages = [
  { directory: "web", name: "@guionai/web" },
  { directory: "pi-web", name: "@guionai/pi-web" },
  { directory: "dsh-web", name: "@guionai/dsh-web" },
];
const repositoryUrl = "git+https://github.com/GuionAI/web.git";
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const workspace = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (typeof version !== "string" || !semver.test(version)) {
  console.error("usage: node scripts/release-dry-run.mjs <x.y.z>");
  process.exit(2);
}

const errors = [];
for (const { directory, name } of publicPackages) {
  const manifestPath = join(workspace, "packages", directory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== name || manifest.private === true) {
    errors.push(`${manifestPath} is not the public ${name} package`);
  }
  if (manifest.repository?.url !== repositoryUrl) {
    errors.push(
      `${name}: repository.url ${JSON.stringify(manifest.repository?.url)} != ${repositoryUrl}`,
    );
  }
  if (manifest.version !== version) {
    errors.push(`${name}: version ${manifest.version} != ${version}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  `release versions match: ${publicPackages.length} manifests at ${version}`,
);
