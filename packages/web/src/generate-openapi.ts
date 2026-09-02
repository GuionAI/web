#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

import { createHttpOpenAPIDocument } from "./http.js";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const packageManifestPath = resolve(packageDirectory, "../package.json");

/** Serializes the release OpenAPI contract to a YAML file. */
export async function generateOpenAPI(output?: string): Promise<string> {
  const outputPath = output
    ? resolve(output)
    : join(packageDirectory, "openapi.yaml");
  const manifest = JSON.parse(await readFile(packageManifestPath, "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string" || manifest.version.length === 0)
    throw new Error("package version is required to generate OpenAPI");

  const document = createHttpOpenAPIDocument(manifest.version);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, stringify(document), "utf8");
  return outputPath;
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const outputPath = await generateOpenAPI(process.argv[2]);
  process.stdout.write(`generated ${outputPath}\n`);
}
