#!/usr/bin/env node
// Verifies tag-to-package release invariants without network access.
// Usage: node scripts/release-dry-run.mjs <x.y.z>
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_PACKAGES,
  distTagForVersion,
  packagePublishPlan,
} from "./publish-packages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(here, "..");
const version = process.argv[2];

try {
  distTagForVersion(version);
} catch {
  console.error("usage: node scripts/release-dry-run.mjs <x.y.z>");
  process.exit(2);
}

const publishPlan = packagePublishPlan(workspace);
const errors = [];
if (publishPlan.length !== 3)
  errors.push(`publish plan has ${publishPlan.length} packages, expected 3`);
if (
  publishPlan.map((entry) => entry.name).join("\n") !==
  PUBLIC_PACKAGES.map((entry) => entry.name).join("\n")
) {
  errors.push(
    "publish plan package inventory does not match the public package inventory",
  );
}

for (const entry of publishPlan) {
  const manifest = JSON.parse(
    readFileSync(join(entry.path, "package.json"), "utf8"),
  );
  if (manifest.version !== version)
    errors.push(`${manifest.name}: version ${manifest.version} != ${version}`);
  if (manifest.private === true)
    errors.push(`${manifest.name}: public package is private`);
  if (JSON.stringify(manifest).includes("workspace:")) {
    errors.push(`${manifest.name}: manifest contains a workspace protocol`);
  }
  if (manifest.optionalDependencies)
    errors.push(`${manifest.name}: optional dependencies are not allowed`);
  for (const hook of ["preinstall", "install", "postinstall"]) {
    if (manifest.scripts?.[hook])
      errors.push(`${manifest.name}: ${hook} is not allowed`);
  }
  if (
    /native|goreleaser|staging|platform archive/i.test(JSON.stringify(manifest))
  ) {
    errors.push(
      `${manifest.name}: manifest references a removed native release mechanism`,
    );
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  `dry-run ok: ${publishPlan.length} manifests at ${version} (${distTagForVersion(version)})`,
);
