#!/usr/bin/env node
// Exercises release planning and npm's exact-version skip/fail behavior with a
// test-owned fake npm executable. No registry, credentials, tags, or packages
// are mutated.
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PUBLIC_PACKAGES,
  distTagForVersion,
  packagePublishPlan,
  publishReleasePackages,
} from "./publish-packages.mjs";

const root = mkdtempSync(join(tmpdir(), "guionai-web-publish-plan-"));
const logPath = join(root, "npm-log.jsonl");
const fakeNpm = join(root, "fake-npm.mjs");

function makeWorkspace(version) {
  const workspace = join(root, version.replace(/[^A-Za-z0-9]/g, "_"));
  for (const { dir, name } of PUBLIC_PACKAGES) {
    const directory = join(workspace, "packages", dir);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name,
        version,
        type: "module",
        publishConfig: { access: "public" },
      }) + "\n",
    );
  }
  return workspace;
}

writeFileSync(
  fakeNpm,
  `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "view") {
  const name = args[1];
  if (process.env.FAKE_NPM_MODE === "ambiguous") { process.stdout.write(JSON.stringify([name.split("@").pop()])); process.exit(0); }
  if (process.env.FAKE_NPM_MODE === "network") { process.stderr.write("ECONNREFUSED fixture registry"); process.exit(1); }
  if (process.env.FAKE_NPM_MODE === "skip-first" && name.startsWith("@guionai/web@")) { process.stdout.write(JSON.stringify(name.slice(name.lastIndexOf("@") + 1))); process.exit(0); }
  process.stderr.write("npm error code E404\\nnpm error 404 Not Found"); process.exit(1);
}
if (args[0] === "publish") process.exit(0);
process.stderr.write("unexpected fake npm command"); process.exit(1);
`,
);
chmodSync(fakeNpm, 0o755);

function run(version, mode, provenance = false) {
  writeFileSync(logPath, "");
  return publishReleasePackages(packagePublishPlan(makeWorkspace(version)), {
    npmCommand: fakeNpm,
    registry: "https://registry.invalid",
    env: { ...process.env, FAKE_NPM_LOG: logPath, FAKE_NPM_MODE: mode },
    provenance,
  });
}

try {
  if (
    distTagForVersion("1.2.3") !== "latest" ||
    distTagForVersion("1.2.3-beta.1") !== "beta"
  ) {
    throw new Error("stable/prerelease dist-tag derivation changed");
  }
  for (const version of ["1.2", "v1.2.3", "1.2.3-"]) {
    try {
      distTagForVersion(version);
      throw new Error(`invalid SemVer ${version} was accepted`);
    } catch (error) {
      if (
        !String(error.message).startsWith(
          "invalid synchronized package version",
        )
      )
        throw error;
    }
  }

  const stable = run("1.2.3", "missing", true);
  if (
    stable.distTag !== "latest" ||
    stable.published.length !== 3 ||
    stable.skipped.length !== 0
  ) {
    throw new Error("stable publish plan did not publish all three packages");
  }
  const stableCalls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const publishes = stableCalls.filter((args) => args[0] === "publish");
  if (
    publishes.length !== 3 ||
    publishes.some(
      (args) =>
        !args.includes("--access") ||
        !args.includes("public") ||
        !args.includes("--tag") ||
        !args.includes("latest") ||
        !args.includes("--provenance"),
    )
  ) {
    throw new Error(
      "stable publication did not use public/latest/provenance arguments",
    );
  }

  const beta = run("1.2.4-beta.1", "skip-first");
  if (
    beta.distTag !== "beta" ||
    beta.skipped.join(",") !== "@guionai/web" ||
    beta.published.length !== 2
  ) {
    throw new Error("prerelease exact-version skip behavior changed");
  }
  const betaCalls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  if (
    betaCalls
      .filter((args) => args[0] === "publish")
      .some((args) => !args.includes("beta"))
  ) {
    throw new Error("prerelease publication did not use the beta dist-tag");
  }

  for (const mode of ["ambiguous", "network"]) {
    try {
      run("2.0.0", mode);
      throw new Error(`${mode} registry response was accepted`);
    } catch (error) {
      if (!String(error.message).includes("registry lookup")) throw error;
    }
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    if (calls.some((args) => args[0] === "publish"))
      throw new Error(`${mode} response attempted a publish`);
  }
  console.log(
    "publish-plan fixtures passed: latest/beta, exact skip, and fail-closed registry handling",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
