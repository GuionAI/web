#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

import { createHttpOpenAPIDocument } from "./http.js";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const packageManifestPath = resolve(packageDirectory, "../package.json");
const outputPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(packageDirectory, "openapi.yaml");

const manifest = JSON.parse(await readFile(packageManifestPath, "utf8")) as {
  version?: unknown;
};
if (typeof manifest.version !== "string" || manifest.version.length === 0)
  throw new Error("package version is required to generate OpenAPI");

const document = createHttpOpenAPIDocument(manifest.version);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, stringify(document), "utf8");
process.stdout.write(`generated ${outputPath}\n`);
