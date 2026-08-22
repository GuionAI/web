#!/usr/bin/env node
// Defines and consumes the single npm publish order for a Guion Web release.
// The three public packages are intentionally published sequentially so an
// interrupted release can safely resume at immutable package versions.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultWorkspace = join(here, "..");
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const PUBLIC_PACKAGES = [
  { dir: "web", name: "@guionai/web" },
  { dir: "pi-web", name: "@guionai/pi-web" },
  { dir: "dsh-web", name: "@guionai/dsh-web" },
];

// This is intentionally local instead of importing a package manager's private
// semver implementation: the release plan only needs to classify a complete
// package version as stable or prerelease.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(
      `invalid package metadata at ${join(path, "package.json")}: ${error.message}`,
    );
  }
}

// packagePublishPlan is the one source of release inventory and publish order.
// Version sync, dry-run verification, tests, and the release workflow all use
// this exact list rather than package-manager workspace discovery.
export function packagePublishPlan(workspace = defaultWorkspace) {
  const plan = PUBLIC_PACKAGES.map(({ dir, name }) => {
    const path = join(workspace, "packages", dir);
    const manifest = readManifest(path);
    if (manifest.private === true)
      throw new Error(`${name}: public package is marked private`);
    if (manifest.name !== name) {
      throw new Error(
        `package metadata at ${path} has name ${manifest.name ?? "missing"}; expected ${name}`,
      );
    }
    if (typeof manifest.version !== "string" || !manifest.version) {
      throw new Error(`${name}: package metadata has no version`);
    }
    return { kind: "main", dir, name, version: manifest.version, path };
  });
  if (plan.length !== 3)
    throw new Error(
      `expected exactly three public packages, found ${plan.length}`,
    );
  return plan;
}

export function distTagForVersion(version) {
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    throw new Error(`invalid synchronized package version: ${version ?? ""}`);
  }
  return version.includes("-") ? "beta" : "latest";
}

function errorOutput(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .map((value) => (value == null ? "" : String(value).trim()))
    .filter(Boolean)
    .join("\n");
}

function isUnambiguousNotFound(error) {
  const stderr = [error?.stderr, error?.stdout]
    .map((value) => (value == null ? "" : String(value)))
    .join("\n");
  return (
    /\bE404\b/i.test(stderr) ||
    /npm\s+error\s+404\b/i.test(stderr) ||
    /\b404\s+(?:not found|no match|does not exist)\b/i.test(stderr) ||
    /\bHTTP\/\d(?:\.\d)?\s+404\b/i.test(stderr)
  );
}

function validatePlanEntry(entry) {
  if (!entry || entry.kind !== "main") {
    throw new Error(
      `invalid publish plan entry kind: ${entry?.kind ?? "missing"}`,
    );
  }
  if (typeof entry.name !== "string" || !entry.name)
    throw new Error("invalid publish plan entry name");
  if (typeof entry.version !== "string" || !entry.version) {
    throw new Error(`${entry.name}: publish plan entry has no version`);
  }
  if (typeof entry.path !== "string" || !entry.path) {
    throw new Error(`${entry.name}: publish plan entry has no package path`);
  }

  const manifest = readManifest(entry.path);
  if (manifest.private === true)
    throw new Error(`${entry.name}: private packages cannot be published`);
  if (manifest.name !== entry.name) {
    throw new Error(
      `${entry.name}: publish plan name does not match package metadata ${manifest.name}`,
    );
  }
  if (manifest.version !== entry.version) {
    throw new Error(
      `${entry.name}: publish plan version ${entry.version} does not match metadata ${manifest.version}`,
    );
  }
  distTagForVersion(entry.version);
  return entry;
}

function readPublishedVersion(entry, options) {
  const { npmCommand, registry, env } = options;
  const specifier = `${entry.name}@${entry.version}`;
  let stdout;
  try {
    stdout = execFileSync(
      npmCommand,
      ["view", specifier, "version", "--json", "--registry", registry],
      {
        cwd: entry.path,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    if (isUnambiguousNotFound(error)) return false;
    throw new Error(
      `registry lookup failed for ${specifier}: ${errorOutput(error)}`,
    );
  }

  let observed;
  try {
    observed = JSON.parse(String(stdout).trim());
  } catch (error) {
    throw new Error(
      `registry lookup returned malformed metadata for ${specifier}: ${error.message}`,
    );
  }
  if (observed !== entry.version) {
    throw new Error(
      `registry lookup returned ${JSON.stringify(observed)} for ${specifier}; refusing to publish`,
    );
  }
  return true;
}

export function publishReleasePackages(
  plan = packagePublishPlan(),
  {
    npmCommand = "npm",
    registry = NPM_REGISTRY,
    env = process.env,
    provenance = false,
  } = {},
) {
  if (!Array.isArray(plan) || plan.length !== PUBLIC_PACKAGES.length) {
    throw new Error("publish plan must contain exactly three public packages");
  }
  const entries = plan.map(validatePlanEntry);
  const names = entries.map((entry) => entry.name);
  if (
    names.join("\n") !== PUBLIC_PACKAGES.map((entry) => entry.name).join("\n")
  ) {
    throw new Error(
      "publish plan does not match the three-package public inventory",
    );
  }
  const version = entries[0].version;
  if (entries.some((entry) => entry.version !== version)) {
    throw new Error("all public packages must share one synchronized version");
  }
  const tag = distTagForVersion(version);
  const published = [];
  const skipped = [];

  for (const entry of entries) {
    const specifier = `${entry.name}@${entry.version}`;
    if (readPublishedVersion(entry, { npmCommand, registry, env })) {
      console.log(`skipping ${specifier}: exact version already exists`);
      skipped.push(entry.name);
      continue;
    }

    console.log(`publishing ${specifier} with dist-tag ${tag}`);
    const args = [
      "publish",
      "--no-git-checks",
      "--access",
      "public",
      "--tag",
      tag,
      "--registry",
      registry,
    ];
    if (provenance) args.push("--provenance");
    execFileSync(npmCommand, args, { cwd: entry.path, env, stdio: "inherit" });
    published.push(entry.name);
  }

  console.log(
    `publish plan complete: ${published.length} published, ${skipped.length} skipped, ${version} (${tag})`,
  );
  return { version, distTag: tag, published, skipped };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    publishReleasePackages(undefined, {
      provenance: process.argv.includes("--provenance"),
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
