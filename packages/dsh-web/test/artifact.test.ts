import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let artifactRoot = "";
let artifactTemp = "";

beforeAll(() => {
  execFileSync("pnpm", ["run", "build"], { cwd: packageRoot, stdio: "ignore" });
  artifactTemp = mkdtempSync(
    join(tmpdir(), "guionai-dsh-web-packed-contract-"),
  );
  execFileSync("pnpm", ["pack", "--pack-destination", artifactTemp], {
    cwd: packageRoot,
    stdio: "ignore",
  });
  const tarballs = readdirSync(artifactTemp).filter((file) =>
    file.endsWith(".tgz"),
  );
  if (tarballs.length !== 1)
    throw new Error("expected one packed DSH Web artifact");
  const installed = join(artifactTemp, "installed");
  mkdirSync(installed);
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({ name: "dsh-web-packed-contract", private: true }) + "\n",
  );
  execFileSync(
    "pnpm",
    ["add", "--ignore-scripts", `file:${join(artifactTemp, tarballs[0]!)}`],
    {
      cwd: installed,
      env: {
        ...process.env,
        npm_config_store_dir: join(artifactTemp, "store"),
      },
      stdio: "ignore",
    },
  );
  artifactRoot = join(installed, "node_modules", "@guionai", "dsh-web");
  writeHostFakes();
}, 30_000);

function writeHostFakes(): void {
  const dependencies = {
    "dsh-settings":
      "export function settingsNamespace(namespace) { return namespace; }\n",
    schemastery:
      "const z = { object: () => ({}), union: () => ({ default: () => ({}) }) }; export default z;\n",
    "dsh-credentials": "export function credentialRef(ref) { return ref; }\n",
    "dsh-tools":
      "export function defineTool(definition) { return definition; }\n",
  };
  for (const [name, source] of Object.entries(dependencies)) {
    const directory = join(artifactRoot, "node_modules", "@deepseek-ai", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.js" }) + "\n",
    );
    writeFileSync(join(directory, "index.js"), source);
  }
}

afterAll(() => {
  if (artifactTemp !== "")
    rmSync(artifactTemp, { recursive: true, force: true });
});
function manifest(): any {
  return JSON.parse(readFileSync(join(artifactRoot, "package.json"), "utf8"));
}

describe("DSH rc.8 packed package contract", () => {
  it("contains valid host ESM, browser client, declarations, patch, and peer-only metadata", async () => {
    const packed = manifest();
    const host = await import(
      `${pathToFileURL(join(artifactRoot, "dist", "index.js")).href}?host=1`
    );
    expect(packed.name).toBe("@guionai/dsh-web");
    expect(packed.main).toBe("dist/index.js");
    expect(packed.types).toBe("dist/index.d.ts");
    expect(packed.exports["./client"]).toEqual({
      types: "./dist/client.d.cts",
      default: "./dist/client.js",
    });
    expect(readdirSync(join(artifactRoot, "dist"))).toEqual(
      expect.arrayContaining([
        "index.js",
        "index.d.ts",
        "client.js",
        "client.d.cts",
      ]),
    );
    expect(packed.dependencies).toBeUndefined();
    expect(packed.optionalDependencies).toBeUndefined();
    expect(
      packed.scripts?.install ?? packed.scripts?.postinstall,
    ).toBeUndefined();
    expect(JSON.stringify(packed)).not.toContain("workspace:");
    expect(
      Object.keys(packed.peerDependencies).filter(
        (name) => name === "react" || name.startsWith("@deepseek-ai/"),
      ).length,
    ).toBeGreaterThan(10);
    expect(host.name).toBe("guionai-dsh-web");
    expect(host.inject).toEqual(["web", "credentials", "settings", "tools"]);
    let provider: any;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      expect(String(url)).toBe("https://api.exa.ai/search");
      expect(
        (init.headers as Headers).get?.("x-api-key") ??
          (init.headers as any)["x-api-key"],
      ).toBe("fixture-key");
      return Response.json({
        results: [
          {
            title: "Packed",
            url: "https://example.test",
            highlights: ["fixture"],
          },
        ],
      });
    };
    try {
      host.apply({
        settings: { register: () => ({ get: () => ({ provider: "exa" }) }) },
        credentials: {
          resolve: async () => ({ value: "fixture-key", source: "test" }),
        },
        web: {
          registerSearchProvider: (value: unknown) => {
            provider = value;
          },
        },
        tools: { register: () => undefined },
      });
      await expect(
        provider.search({ query: "packed fixture" }),
      ).resolves.toEqual({
        sources: [
          { url: "https://example.test", title: "Packed", snippet: "fixture" },
        ],
        truncated: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const patch = parse(
      readFileSync(join(artifactRoot, "cordis.patch.yml"), "utf8"),
    ) as any[];
    expect(patch.find((entry) => entry.id === "web")).toEqual({
      id: "web",
      name: "@deepseek-ai/dsh-web",
      config: { searchProvider: "guionai-web-search" },
    });
    expect(patch.find((entry) => entry.id === "tool-web")).toEqual({
      id: "tool-web",
      disabled: true,
    });
    expect(
      patch.find((entry) => Array.isArray(entry.insert))?.insert,
    ).toContainEqual({
      id: "guionai-dsh-web",
      name: "@guionai/dsh-web",
      inject: ["web", "credentials", "settings", "tools"],
    });
  });

  it("loads the packed browser entry through the supported lazy module contract", async () => {
    const previousWindow = (globalThis as any).window;
    const registrations: any[] = [];
    (globalThis as any).window = {
      __ModuleLoader__: {
        load: (registration: unknown) => registrations.push(registration),
      },
    };
    try {
      await import(
        `${pathToFileURL(join(artifactRoot, "dist", "client.js")).href}?client=1`
      );
      expect(registrations).toHaveLength(1);
      expect(registrations[0].id).toBe("@guionai/dsh-web");
      const loaded = registrations[0].factory((specifier: string) => {
        expect(specifier).toBe("react");
        return {
          createElement: () => ({}),
          useEffect: () => undefined,
          useState: <T>(value: T) => [value, () => undefined] as const,
        };
      });
      expect(loaded.inject).toEqual([
        "connection",
        "remote",
        "settingsScope",
        "slots",
      ]);
      expect(typeof loaded.apply).toBe("function");
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });
});
