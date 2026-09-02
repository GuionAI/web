import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { generateOpenAPI } from "../src/generate-openapi.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedPaths = [
  "/v1/docs/fetch",
  "/v1/docs/resolve",
  "/v1/fetch",
  "/v1/finance",
  "/v1/links",
  "/v1/search",
  "/v1/source-search",
  "/v1/sports",
  "/v1/time",
  "/v1/weather",
];

describe("release OpenAPI artifact", () => {
  it("serializes and parses the versioned contract from a test-owned file", async () => {
    const artifactRoot = mkdtempSync(
      join(tmpdir(), "guionai-web-openapi-artifact-"),
    );
    try {
      const outputPath = join(artifactRoot, "openapi.yaml");
      await generateOpenAPI(outputPath);
      const document = parse(readFileSync(outputPath, "utf8")) as {
        openapi?: unknown;
        info?: { version?: unknown };
        paths?: Record<string, unknown>;
      };
      const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      ) as { version: string };

      expect(document.openapi).toBe("3.1.0");
      expect(document.info?.version).toBe(manifest.version);
      expect(Object.keys(document.paths ?? {}).sort()).toEqual(expectedPaths);
      expect(
        Object.keys(document.paths ?? {}).some((path) =>
          path.includes("bridge"),
        ),
      ).toBe(false);
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });
});
