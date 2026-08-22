#!/usr/bin/env node
// Packs every public package into a test-owned directory and validates the
// published metadata and artifact boundary instead of trusting source files.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_PACKAGES, packagePublishPlan } from "./publish-packages.mjs";

const workspace = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "guionai-web-artifacts-"));
const isolatedEnv = {
  ...process.env,
  HOME: join(root, "home"),
  XDG_CACHE_HOME: join(root, "cache"),
  npm_config_store_dir: join(root, "store"),
  npm_config_ignore_scripts: "true",
};

function tarballManifest(tarball) {
  return JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  );
}

function tarballFiles(tarball) {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((file) => file.replace(/^package\//, ""));
}

function assertCommon(manifest, files, entry) {
  if (manifest.name !== entry.name || manifest.version !== entry.version) {
    throw new Error(
      `${entry.name}: packed identity does not match the publish plan`,
    );
  }
  if (manifest.license !== "Apache-2.0" || manifest.engines?.node !== ">=20") {
    throw new Error(
      `${entry.name}: packed license or Node support metadata is wrong`,
    );
  }
  if (
    manifest.homepage !== "https://github.com/guionai/web#readme" ||
    manifest.bugs?.url !== "https://github.com/guionai/web/issues" ||
    manifest.repository?.url !== "git+https://github.com/guionai/web.git" ||
    manifest.repository?.directory !== `packages/${entry.dir}` ||
    manifest.publishConfig?.registry !== "https://registry.npmjs.org" ||
    manifest.publishConfig?.access !== "public"
  ) {
    throw new Error(
      `${entry.name}: packed public repository or npm metadata is wrong`,
    );
  }
  if (
    JSON.stringify(manifest).includes("workspace:") ||
    JSON.stringify(manifest).match(/native|goreleaser|stage-natives|\.node\b/i)
  ) {
    throw new Error(
      `${entry.name}: packed metadata has a removed native/workspace reference`,
    );
  }
  if (
    manifest.optionalDependencies ||
    ["preinstall", "install", "postinstall"].some(
      (hook) => manifest.scripts?.[hook],
    )
  ) {
    throw new Error(
      `${entry.name}: packed artifact has optional native dependencies or install scripts`,
    );
  }
  if (
    !files.includes("package.json") ||
    !files.some((file) => file.startsWith("dist/"))
  ) {
    throw new Error(
      `${entry.name}: packed artifact is missing package metadata or dist`,
    );
  }
  const allowed =
    entry.name === "@guionai/dsh-web"
      ? /^(package\.json|LICENSE|README\.md|cordis\.patch\.yml|dist\/[^/]+)$/
      : /^(package\.json|LICENSE|dist\/[^/]+)$/;
  if (files.some((file) => !allowed.test(file))) {
    throw new Error(
      `${entry.name}: packed unexpected file(s): ${files.filter((file) => !allowed.test(file)).join(", ")}`,
    );
  }
}

function assertPackageContract(manifest, files, entry) {
  if (entry.name === "@guionai/web") {
    if (
      manifest.bin?.web !== "./dist/cli.js" ||
      manifest.exports?.["."] !== "./dist/index.js" ||
      !files.includes("dist/cli.js") ||
      !files.includes("dist/index.js")
    ) {
      throw new Error(
        "@guionai/web: packed CLI bin or library export is missing",
      );
    }
    return;
  }
  if (entry.name === "@guionai/pi-web") {
    const peers = Object.keys(manifest.peerDependencies ?? {})
      .sort()
      .join(",");
    if (
      peers !==
        "@earendil-works/pi-ai,@earendil-works/pi-coding-agent,typebox" ||
      JSON.stringify(manifest.pi?.extensions) !==
        JSON.stringify(["./dist/index.js"]) ||
      manifest.bin ||
      manifest.dependencies ||
      !files.includes("dist/index.js")
    ) {
      throw new Error(
        "@guionai/pi-web: packed Pi registration or peer-only contract is wrong",
      );
    }
    return;
  }
  const client = manifest.exports?.["./client"];
  if (
    manifest.main !== "dist/index.js" ||
    manifest.types !== "dist/index.d.ts" ||
    client?.types !== "./dist/client.d.cts" ||
    client?.default !== "./dist/client.js" ||
    !files.includes("cordis.patch.yml") ||
    !files.includes("dist/index.js") ||
    !files.includes("dist/client.js") ||
    manifest.dependencies
  ) {
    throw new Error(
      "@guionai/dsh-web: packed DSH host/client artifact contract is wrong",
    );
  }
}

try {
  const plan = packagePublishPlan(workspace);
  if (
    plan.length !== 3 ||
    plan.map((entry) => entry.name).join("\n") !==
      PUBLIC_PACKAGES.map((entry) => entry.name).join("\n")
  ) {
    throw new Error(
      "artifact validation requires exactly the three public Guion packages",
    );
  }
  for (const entry of plan) {
    const destination = join(root, entry.dir);
    execFileSync("pnpm", ["pack", "--pack-destination", destination], {
      cwd: entry.path,
      env: isolatedEnv,
      stdio: "pipe",
    });
    const files = readdirSync(destination).filter((file) =>
      file.endsWith(".tgz"),
    );
    if (files.length !== 1)
      throw new Error(`${entry.name}: expected exactly one tarball`);
    const tarball = join(destination, files[0]);
    const manifest = tarballManifest(tarball);
    const packedFiles = tarballFiles(tarball);
    assertCommon(manifest, packedFiles, entry);
    assertPackageContract(manifest, packedFiles, entry);
  }
  console.log(
    "packed artifact metadata passed for @guionai/web, @guionai/pi-web, and @guionai/dsh-web",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
