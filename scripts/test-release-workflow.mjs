#!/usr/bin/env node
// Static release-policy contract. This keeps workflow metadata failures local
// and does not invoke GitHub, npm, or credentials.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_PACKAGES, packagePublishPlan } from "./publish-packages.mjs";

const workspace = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = readFileSync(
  join(workspace, ".github", "workflows", "release.yaml"),
  "utf8",
);
const ci = readFileSync(
  join(workspace, ".github", "workflows", "ci.yaml"),
  "utf8",
);
const plan = packagePublishPlan(workspace);
const requiredRelease = [
  "node-version: 24",
  "npm@11.10.0",
  "id-token: write",
  "contents: write",
  "environment:\n      name: npm",
  "node scripts/publish-packages.mjs --provenance",
  "gh release create",
  "needs: preflight",
  "node scripts/release-dry-run.mjs",
  "pnpm test:pack",
  "pnpm test:artifacts",
];
const forbiddenRelease = [
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "goreleaser",
  "stage-natives",
  "packages/native",
  "GoReleaser",
  "platform archive",
];
const requiredCi = [
  "ubuntu-latest",
  "windows-latest",
  "pnpm format:check",
  "pnpm typecheck",
  "pnpm build",
  "pnpm test",
  "pnpm test:release",
  "pnpm test:artifacts",
  "pnpm test:pack",
  "pnpm test:windows",
];

if (
  plan.length !== 3 ||
  plan.map((entry) => entry.name).join("\n") !==
    PUBLIC_PACKAGES.map((entry) => entry.name).join("\n")
) {
  throw new Error(
    "workflow validation requires exactly the three public package inventory entries",
  );
}
for (const value of requiredRelease) {
  if (!release.includes(value))
    throw new Error(`release workflow is missing ${value}`);
}
for (const value of forbiddenRelease) {
  if (release.includes(value))
    throw new Error(
      `release workflow retains forbidden native/token logic: ${value}`,
    );
}
for (const value of requiredCi) {
  if (!ci.includes(value)) throw new Error(`CI workflow is missing ${value}`);
}
if (
  (release.match(/^name: Release$/gm) ?? []).length !== 1 ||
  !/jobs:\n  preflight:[\s\S]*\n  release:/.test(release)
) {
  throw new Error(
    "release workflow must retain the two-job preflight/release shape",
  );
}
console.log(
  "workflow policy passed: OIDC npm release, three-package inventory, Linux and Windows CI",
);
