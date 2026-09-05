import { describe, expect, it } from "vitest";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { createWebOperations } from "@guionai/web-core";
import { runCli } from "../src/runner.js";
import {
  DshPresetError,
  COMPATIBLE_PRESET_IDS,
  formatDshDoctor,
  inspectCompatiblePresets,
  resolveDshRuntime,
  syncCompatiblePresets,
  type DshPathOverrides,
} from "../src/dsh.js";

type Fixture = {
  root: string;
  sourcePackageRoot: string;
  sourcePresetRoot: string;
  dshHome: string;
  options: DshPathOverrides;
};

const sourceComposition = (id: string, includeWeb: boolean): string =>
  [
    `# ${id} fixture composition`,
    "- id: persona",
    "  name: fixture:persona",
    ...(includeWeb
      ? [
          "",
          "- id: tool-web",
          "  name: '@deepseek-ai/dsh-tool-web'",
          "  config:",
          "    fetch: true",
          "    searchTimeoutMs: 60000",
        ]
      : []),
    "",
    "- id: tail",
    "  name: fixture:tail",
    "",
  ].join("\n");

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "guionai-web-dsh-test-"));
  const sourcePackageRoot = join(
    root,
    "node_modules",
    "@deepseek-ai",
    "dsh-agent-presets",
  );
  const sourcePresetRoot = join(sourcePackageRoot, "presets");
  const dshHome = join(root, "dsh-home");
  await mkdir(sourcePresetRoot, { recursive: true });
  await writeFile(
    join(sourcePackageRoot, "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh-agent-presets", version: "0.1.2-rc.1" })}\n`,
  );
  for (const id of COMPATIBLE_PRESET_IDS) {
    const directory = join(sourcePresetRoot, id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "agent.cordis.yml"),
      sourceComposition(id, id !== "minimal"),
    );
    await writeFile(
      join(directory, "preset.yml"),
      `name: Fixture ${id}\ndescription: A test preset\norder: 1\n`,
    );
    await writeFile(join(directory, "prompt.md"), `prompt for ${id}\n`);
  }
  return {
    root,
    sourcePackageRoot,
    sourcePresetRoot,
    dshHome,
    options: { sourcePackageRoot, dshHome },
  };
}

async function readComposition(value: Fixture, id: string): Promise<string> {
  return readFile(
    join(value.dshHome, ".agent-presets", id, "agent.cordis.yml"),
    "utf8",
  );
}

async function dispose(value: Fixture): Promise<void> {
  await rm(value.root, { recursive: true, force: true });
}

describe("compatible DSH presets", () => {
  it("derives all four same-id presets without ownership metadata", async () => {
    const value = await fixture();
    try {
      const result = await syncCompatiblePresets(value.options);
      expect(result.created).toEqual([...COMPATIBLE_PRESET_IDS]);
      for (const id of COMPATIBLE_PRESET_IDS) {
        const directory = join(value.dshHome, ".agent-presets", id);
        const rows = parse(await readComposition(value, id)) as Array<
          Record<string, unknown>
        >;
        expect(rows.map((row) => row.id)).toEqual(["persona", "tail"]);
        expect((await readdir(directory)).sort()).toEqual([
          "agent.cordis.yml",
          "preset.yml",
          "prompt.md",
        ]);
      }
    } finally {
      await dispose(value);
    }
  });

  it("refreshes compatible copies and retains unrelated user presets", async () => {
    const value = await fixture();
    try {
      await syncCompatiblePresets(value.options);
      const userRoot = join(value.dshHome, ".agent-presets");
      await mkdir(join(userRoot, "yuki"));
      await writeFile(
        join(userRoot, "yuki", "agent.cordis.yml"),
        "- id: yuki\n  name: fixture:yuki\n",
      );
      const before = await readComposition(value, "standard");
      const result = await syncCompatiblePresets(value.options);
      expect(result.replaced).toEqual([...COMPATIBLE_PRESET_IDS]);
      expect(await readComposition(value, "standard")).toBe(before);
      expect((await readdir(userRoot)).sort()).toEqual(
        [...COMPATIBLE_PRESET_IDS, "yuki"].sort(),
      );
    } finally {
      await dispose(value);
    }
  });

  it("converts an exact official copy without confirmation", async () => {
    const value = await fixture();
    try {
      const target = join(value.dshHome, ".agent-presets", "standard");
      await mkdir(join(value.dshHome, ".agent-presets"), { recursive: true });
      await cp(join(value.sourcePresetRoot, "standard"), target, {
        recursive: true,
      });
      const result = await syncCompatiblePresets(value.options);
      expect(result.replaced).toContain("standard");
      expect(await readComposition(value, "standard")).not.toContain(
        "tool-web",
      );
    } finally {
      await dispose(value);
    }
  });

  it("requires confirmation before replacing modified same-id content", async () => {
    const value = await fixture();
    try {
      const target = join(value.dshHome, ".agent-presets", "standard");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "operator.txt"), "keep me\n");
      await expect(syncCompatiblePresets(value.options)).rejects.toMatchObject({
        code: "dsh-confirmation-required",
      });
      expect(await readFile(join(target, "operator.txt"), "utf8")).toBe(
        "keep me\n",
      );
      let prompted: readonly string[] = [];
      await syncCompatiblePresets(value.options, {
        confirmOverwrite: (ids) => {
          prompted = ids;
          return true;
        },
      });
      expect(prompted).toEqual(["standard"]);
      expect(await readComposition(value, "standard")).not.toContain(
        "tool-web",
      );
    } finally {
      await dispose(value);
    }
  });

  it("fails closed for unsupported versions and unexpected source rows", async () => {
    const value = await fixture();
    try {
      await writeFile(
        join(value.sourcePackageRoot, "package.json"),
        `${JSON.stringify({ name: "@deepseek-ai/dsh-agent-presets", version: "0.1.1" })}\n`,
      );
      await expect(syncCompatiblePresets(value.options)).rejects.toMatchObject({
        code: "dsh-source-unsupported",
      });
      expect(await stat(value.dshHome).catch(() => undefined)).toBeUndefined();

      await writeFile(
        join(value.sourcePackageRoot, "package.json"),
        `${JSON.stringify({ name: "@deepseek-ai/dsh-agent-presets", version: "0.1.2-rc.1" })}\n`,
      );
      await writeFile(
        join(value.sourcePresetRoot, "standard", "agent.cordis.yml"),
        sourceComposition("standard", false),
      );
      await expect(syncCompatiblePresets(value.options)).rejects.toMatchObject({
        code: "dsh-source-invalid",
      });
      expect(await stat(value.dshHome).catch(() => undefined)).toBeUndefined();
    } finally {
      await dispose(value);
    }
  });

  it("doctor compares output with the official and compatible trees", async () => {
    const value = await fixture();
    try {
      expect(
        (await inspectCompatiblePresets(value.options)).presets.map(
          (preset) => preset.status,
        ),
      ).toEqual(["missing", "missing", "missing", "missing"]);
      await syncCompatiblePresets(value.options);
      await writeFile(
        join(value.dshHome, ".agent-presets", "standard", "prompt.md"),
        "tampered\n",
      );
      await rm(join(value.dshHome, ".agent-presets", "ptc"), {
        recursive: true,
      });
      await cp(
        join(value.sourcePresetRoot, "ptc"),
        join(value.dshHome, ".agent-presets", "ptc"),
        { recursive: true },
      );
      const report = await inspectCompatiblePresets(value.options);
      expect(report.ok).toBe(false);
      expect(report.presets.map((preset) => preset.status)).toEqual([
        "conflict",
        "stale",
        "ok",
        "ok",
      ]);
      expect(formatDshDoctor(report)).toContain("DSH doctor: FAILED");
    } finally {
      await dispose(value);
    }
  });

  it("supports interactive confirmation and --yes through the CLI", async () => {
    const value = await fixture();
    try {
      await syncCompatiblePresets(value.options);
      const target = join(value.dshHome, ".agent-presets", "standard");
      await writeFile(join(target, "prompt.md"), "modified\n");
      let confirmed: readonly string[] = [];
      const dependencies = {
        operations: createWebOperations(),
        credentials: () => ({}),
        dsh: value.options,
        confirmDshOverwrite: (ids: readonly string[]) => {
          confirmed = ids;
          return true;
        },
      };
      const output = { stdout: () => undefined, stderr: () => undefined };
      expect(
        await runCli(["node", "web", "dsh", "sync"], dependencies, output),
      ).toBe(0);
      expect(confirmed).toEqual(["standard"]);

      await writeFile(join(target, "prompt.md"), "modified again\n");
      confirmed = [];
      expect(
        await runCli(
          ["node", "web", "dsh", "sync", "--yes"],
          dependencies,
          output,
        ),
      ).toBe(0);
      expect(confirmed).toEqual([]);
      expect(
        await runCli(["node", "web", "dsh", "doctor"], dependencies, output),
      ).toBe(0);
    } finally {
      await dispose(value);
    }
  });

  it("requires the official package manifest and exposes actionable errors", async () => {
    const value = await fixture();
    try {
      expect(
        (
          await resolveDshRuntime({
            sourcePresetRoot: value.sourcePresetRoot,
            dshHome: value.dshHome,
          })
        ).sourcePackageName,
      ).toBe("@deepseek-ai/dsh-agent-presets");
      await rm(join(value.sourcePackageRoot, "package.json"));
      await expect(
        resolveDshRuntime({
          sourcePresetRoot: value.sourcePresetRoot,
          dshHome: value.dshHome,
        }),
      ).rejects.toMatchObject({ code: "dsh-source-invalid" });
      const error = new DshPresetError("dsh-source-invalid", "fixture failure");
      expect(error.message).toBe("fixture failure");
    } finally {
      await dispose(value);
    }
  });

  it("discovers DSH beside a standard node_modules bin shim", async () => {
    const value = await fixture();
    try {
      const dshRoot = join(value.root, "node_modules", "@deepseek-ai", "dsh");
      const executable = join(value.root, "node_modules", ".bin", "dsh");
      await mkdir(join(dshRoot, "lib"), { recursive: true });
      await mkdir(join(value.root, "node_modules", ".bin"), {
        recursive: true,
      });
      await writeFile(
        join(dshRoot, "package.json"),
        `${JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.2-rc.1" })}\n`,
      );
      await writeFile(join(dshRoot, "lib", "bin.js"), "// fixture\n");
      await writeFile(executable, "#!/bin/sh\n");
      const runtime = await resolveDshRuntime({
        dshExecutable: executable,
        dshHome: value.dshHome,
      });
      expect(runtime.sourcePackageRoot).toBe(
        await realpath(value.sourcePackageRoot),
      );
    } finally {
      await dispose(value);
    }
  });
});
