#!/usr/bin/env node
// CI-friendly invariant test. It exercises version sync and tag validation in
// disposable workspaces, never changing the checkout or contacting npm.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_PACKAGES, packagePublishPlan } from "./publish-packages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(here, "..");
const sourcePlan = packagePublishPlan(workspace);

function createFixtureWorkspace() {
  const fixture = mkdtempSync(
    join(tmpdir(), "guionai-web-release-invariants-"),
  );
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  for (const entry of sourcePlan) {
    const destination = join(fixture, relative(workspace, entry.path));
    mkdirSync(destination, { recursive: true });
    copyFileSync(
      join(entry.path, "package.json"),
      join(destination, "package.json"),
    );
  }
  for (const script of [
    "publish-packages.mjs",
    "release-dry-run.mjs",
    "sync-version.mjs",
  ]) {
    copyFileSync(
      join(workspace, "scripts", script),
      join(fixture, "scripts", script),
    );
  }
  return fixture;
}

function runFixture(version) {
  const fixture = createFixtureWorkspace();
  try {
    execFileSync(process.execPath, ["scripts/sync-version.mjs", version], {
      cwd: fixture,
      stdio: "inherit",
    });
    execFileSync(process.execPath, ["scripts/release-dry-run.mjs", version], {
      cwd: fixture,
      stdio: "inherit",
    });
    console.log(
      `release invariants hold for ${sourcePlan.length} manifests at ${version}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    console.log("test-owned release fixture removed");
  }
}

if (
  sourcePlan.length !== 3 ||
  sourcePlan.map((entry) => entry.name).join("\n") !==
    PUBLIC_PACKAGES.map((entry) => entry.name).join("\n")
) {
  throw new Error(
    "release plan does not contain exactly the three public Guion packages",
  );
}
runFixture("0.0.0-test.1");
runFixture("1.2.3");
