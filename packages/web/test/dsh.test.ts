import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
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
  MANAGED_MARKER_FILE,
  MANAGED_PRESET_IDS,
  formatDshDoctor,
  inspectManagedPresets,
  resolveDshRuntime,
  syncManagedPresets,
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
          "# The source row is removed structurally by sync.",
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
    JSON.stringify({
      name: "@deepseek-ai/dsh-agent-presets",
      version: "0.1.2-rc.1",
    }) + "\n",
  );
  for (const id of MANAGED_PRESET_IDS) {
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

async function dispose(value: Fixture): Promise<void> {
  await rm(value.root, { recursive: true, force: true });
}

async function readPreset(
  fixtureValue: Fixture,
  id: string,
): Promise<{
  composition: string;
  marker: Record<string, unknown>;
}> {
  const directory = join(fixtureValue.dshHome, ".agent-presets", id);
  return {
    composition: await readFile(join(directory, "agent.cordis.yml"), "utf8"),
    marker: JSON.parse(
      await readFile(join(directory, MANAGED_MARKER_FILE), "utf8"),
    ) as Record<string, unknown>,
  };
}

describe("managed DSH presets", () => {
  it("derives all four same-id presets and removes only official tool-web rows", async () => {
    const value = await fixture();
    try {
      const result = await syncManagedPresets(value.options);
      expect(result.created).toEqual([...MANAGED_PRESET_IDS]);
      expect(result.replaced).toEqual([]);
      for (const id of MANAGED_PRESET_IDS) {
        const preset = await readPreset(value, id);
        const rows = parse(preset.composition) as Array<
          Record<string, unknown>
        >;
        expect(rows.map((row) => row.id)).toEqual(["persona", "tail"]);
        expect(preset.marker).toMatchObject({
          managedBy: "@guionai/web",
          markerVersion: 1,
          presetId: id,
          sourcePackage: "@deepseek-ai/dsh-agent-presets",
          sourcePackageVersion: "0.1.2-rc.1",
          sourcePreset: `@deepseek-ai/dsh-agent-presets/presets/${id}`,
        });
        expect(typeof preset.marker.sourceIdentity).toBe("string");
      }
      const minimal = await readPreset(value, "minimal");
      expect(minimal.composition).toContain("# minimal fixture composition");
      expect(minimal.composition).not.toContain("tool-web");
    } finally {
      await dispose(value);
    }
  });

  it("refreshes marked copies idempotently while retaining ordinary user presets", async () => {
    const value = await fixture();
    try {
      await syncManagedPresets(value.options);
      const userRoot = join(value.dshHome, ".agent-presets");
      await mkdir(join(userRoot, "yuki"), { recursive: true });
      await writeFile(
        join(userRoot, "yuki", "agent.cordis.yml"),
        "- id: yuki\n  name: fixture:yuki\n",
      );
      const first = await readPreset(value, "standard");
      const second = await syncManagedPresets(value.options);
      expect(second.replaced).toEqual([...MANAGED_PRESET_IDS]);
      expect(second.created).toEqual([]);
      expect(await readPreset(value, "standard")).toEqual(first);
      expect(
        await stat(join(userRoot, "yuki", "agent.cordis.yml")),
      ).toBeDefined();
      expect((await readdir(userRoot)).sort()).toEqual(
        [...MANAGED_PRESET_IDS, "yuki"].sort(),
      );
    } finally {
      await dispose(value);
    }
  });

  it("preflights unmarked same-id conflicts without mutating any preset", async () => {
    const value = await fixture();
    try {
      const userRoot = join(value.dshHome, ".agent-presets");
      await mkdir(join(userRoot, "standard"), { recursive: true });
      await writeFile(
        join(userRoot, "standard", "agent.cordis.yml"),
        "user-owned standard\n",
      );
      await expect(syncManagedPresets(value.options)).rejects.toMatchObject({
        code: "dsh-preset-conflict",
      });
      expect(
        await readFile(join(userRoot, "standard", "agent.cordis.yml"), "utf8"),
      ).toBe("user-owned standard\n");
      expect(await readdir(userRoot)).toEqual(["standard"]);
    } finally {
      await dispose(value);
    }
  });

  it("fails closed for unsupported versions and unexpected source rows", async () => {
    const value = await fixture();
    try {
      await writeFile(
        join(value.sourcePackageRoot, "package.json"),
        JSON.stringify({
          name: "@deepseek-ai/dsh-agent-presets",
          version: "0.1.1",
        }) + "\n",
      );
      await expect(syncManagedPresets(value.options)).rejects.toMatchObject({
        code: "dsh-source-unsupported",
      });
      expect(await stat(value.dshHome).catch(() => undefined)).toBeUndefined();

      await writeFile(
        join(value.sourcePackageRoot, "package.json"),
        JSON.stringify({
          name: "@deepseek-ai/dsh-agent-presets",
          version: "0.1.2-rc.1",
        }) + "\n",
      );

      await writeFile(
        join(value.sourcePresetRoot, "standard", "agent.cordis.yml"),
        sourceComposition("standard", false),
      );
      await expect(syncManagedPresets(value.options)).rejects.toMatchObject({
        code: "dsh-source-invalid",
      });
      expect(await stat(value.dshHome).catch(() => undefined)).toBeUndefined();

      await writeFile(
        join(value.sourcePresetRoot, "standard", "agent.cordis.yml"),
        sourceComposition("standard", true).replace(
          "  config:\n",
          "  extra: true\n  config:\n",
        ),
      );
      await expect(syncManagedPresets(value.options)).rejects.toMatchObject({
        code: "dsh-source-invalid",
      });
      expect(await stat(value.dshHome).catch(() => undefined)).toBeUndefined();
    } finally {
      await dispose(value);
    }
  });

  it("doctor is read-only and distinguishes missing, incomplete, stale, and conflict outputs", async () => {
    const value = await fixture();
    try {
      const missing = await inspectManagedPresets(value.options);
      expect(missing.ok).toBe(false);
      expect(missing.presets.map((preset) => preset.status)).toEqual([
        "missing",
        "missing",
        "missing",
        "missing",
      ]);
      await syncManagedPresets(value.options);
      const standard = join(value.dshHome, ".agent-presets", "standard");
      await writeFile(
        join(standard, "agent.cordis.yml"),
        "not: a composition\n",
      );
      await writeFile(
        join(value.dshHome, ".agent-presets", "ptc", MANAGED_MARKER_FILE),
        "{}\n",
      );
      await writeFile(
        join(value.dshHome, ".agent-presets", "cordis", MANAGED_MARKER_FILE),
        JSON.stringify({
          managedBy: "@guionai/web",
          markerVersion: 1,
          presetId: "cordis",
          sourcePackage: "@deepseek-ai/dsh-agent-presets",
          sourcePackageVersion: "0.1.2-rc.1",
          sourceIdentity: "sha256:stale",
        }) + "\n",
      );
      await mkdir(join(value.dshHome, ".agent-presets", "minimal", "nested"), {
        recursive: true,
      });
      const report = await inspectManagedPresets(value.options);
      expect(report.ok).toBe(false);
      expect(report.presets.map((preset) => preset.status)).toEqual([
        "incomplete",
        "conflict",
        "stale",
        "ok",
      ]);
      expect(formatDshDoctor(report)).toContain("DSH doctor: FAILED");
      expect(await readFile(join(standard, "agent.cordis.yml"), "utf8")).toBe(
        "not: a composition\n",
      );
    } finally {
      await dispose(value);
    }
  });

  it("doctor compares every copied source file, including deletion and tampering", async () => {
    const value = await fixture();
    try {
      await syncManagedPresets(value.options);
      const standard = join(value.dshHome, ".agent-presets", "standard");
      await rm(join(standard, "prompt.md"));
      let report = await inspectManagedPresets(value.options);
      expect(
        report.presets.find((preset) => preset.id === "standard"),
      ).toMatchObject({ status: "incomplete" });
      expect(report.issues.join("\n")).toContain("missing: prompt.md");

      await writeFile(join(standard, "prompt.md"), "tampered prompt\n");
      report = await inspectManagedPresets(value.options);
      expect(
        report.presets.find((preset) => preset.id === "standard"),
      ).toMatchObject({ status: "incomplete" });
      expect(report.issues.join("\n")).toContain(
        "differs from the official source: prompt.md",
      );

      await writeFile(
        join(standard, "preset.yml"),
        "name: Tampered\ndescription: still valid\norder: 1\n",
      );
      report = await inspectManagedPresets(value.options);
      expect(
        report.presets.find((preset) => preset.id === "standard"),
      ).toMatchObject({ status: "incomplete" });
      expect(report.issues.join("\n")).toContain(
        "differs from the official source: preset.yml",
      );
    } finally {
      await dispose(value);
    }
  });

  it("aborts a same-id ownership race without deleting unknown data", async () => {
    const value = await fixture();
    try {
      await syncManagedPresets(value.options);
      const target = join(value.dshHome, ".agent-presets", "standard");
      const original = join(value.root, "original-standard");
      let raced = false;
      await expect(
        syncManagedPresets({
          ...value.options,
          hooks: {
            beforeRename: async (event) => {
              if (
                !raced &&
                event.id === "standard" &&
                event.phase === "before-backup-rename"
              ) {
                raced = true;
                await rename(target, original);
                await mkdir(target);
                await writeFile(join(target, "operator-data.txt"), "keep me\n");
              }
            },
          },
        }),
      ).rejects.toMatchObject({ code: "dsh-preset-conflict" });
      expect(await readFile(join(target, "operator-data.txt"), "utf8")).toBe(
        "keep me\n",
      );
      expect(
        JSON.parse(await readFile(join(original, MANAGED_MARKER_FILE), "utf8"))
          .managedBy,
      ).toBe("@guionai/web");
      expect(await readdir(join(value.dshHome, ".agent-presets"))).toContain(
        "standard",
      );
    } finally {
      await dispose(value);
    }
  });

  it("serializes concurrent syncs for one DSH_HOME", async () => {
    const value = await fixture();
    try {
      let enteredResolve!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let paused = false;
      const firstRun = syncManagedPresets({
        ...value.options,
        hooks: {
          beforeRename: async (event) => {
            if (
              !paused &&
              event.id === "standard" &&
              event.phase === "before-install-rename"
            ) {
              paused = true;
              enteredResolve();
              await gate;
            }
          },
        },
      });
      await entered;
      let secondDone = false;
      const secondRun = syncManagedPresets(value.options).then((result) => {
        secondDone = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(secondDone).toBe(false);
      release();
      const [first, second] = await Promise.all([firstRun, secondRun]);
      expect(first.created).toEqual([...MANAGED_PRESET_IDS]);
      expect(second.replaced).toEqual([...MANAGED_PRESET_IDS]);
      expect(
        (await readdir(join(value.dshHome, ".agent-presets"))).sort(),
      ).toEqual([...MANAGED_PRESET_IDS].sort());
    } finally {
      await dispose(value);
    }
  });

  it("rolls back newly installed targets after a mid-swap failure", async () => {
    const value = await fixture();
    try {
      let installs = 0;
      await expect(
        syncManagedPresets({
          ...value.options,
          hooks: {
            beforeRename: (event) => {
              if (event.phase === "after-install-rename" && ++installs === 2)
                throw new Error("injected mid-swap failure");
            },
          },
        }),
      ).rejects.toThrow("injected mid-swap failure");
      expect(await readdir(join(value.dshHome, ".agent-presets"))).toEqual([]);
    } finally {
      await dispose(value);
    }
  });

  it("exposes sync and doctor through the runner with fixture-owned paths", async () => {
    const value = await fixture();
    try {
      let stdout = "";
      let stderr = "";
      const dependencies = {
        operations: createWebOperations(),
        credentials: () => ({}),
        dsh: value.options,
      };
      expect(
        await runCli(["node", "web", "dsh", "sync"], dependencies, {
          stdout: (text) => (stdout += text),
          stderr: (text) => (stderr += text),
        }),
      ).toBe(0);
      expect(stdout).toContain("DSH managed presets created all four presets");
      expect(stderr).toBe("");
      stdout = "";
      expect(
        await runCli(["node", "web", "dsh", "doctor"], dependencies, {
          stdout: (text) => (stdout += text),
          stderr: (text) => (stderr += text),
        }),
      ).toBe(0);
      expect(stdout).toContain("DSH doctor: OK");
      expect(stderr).toBe("");

      await writeFile(
        join(value.dshHome, ".agent-presets", "standard", "agent.cordis.yml"),
        "broken\n",
      );
      stdout = "";
      stderr = "";
      expect(
        await runCli(["node", "web", "dsh", "doctor"], dependencies, {
          stdout: (text) => (stdout += text),
          stderr: (text) => (stderr += text),
        }),
      ).toBe(1);
      expect(stdout).toContain("standard: incomplete");
      expect(stderr).toBe("DSH managed preset doctor found problems\n");
    } finally {
      await dispose(value);
    }
  });

  it("requires the official source package manifest and version", async () => {
    const value = await fixture();
    try {
      const runtime = await resolveDshRuntime({
        sourcePresetRoot: value.sourcePresetRoot,
        dshHome: value.dshHome,
      });
      expect(runtime.sourcePresetRoot).toBe(value.sourcePresetRoot);
      expect(runtime.sourcePackageName).toBe("@deepseek-ai/dsh-agent-presets");

      await rm(join(value.sourcePackageRoot, "package.json"));
      await expect(
        resolveDshRuntime({
          sourcePresetRoot: value.sourcePresetRoot,
          dshHome: value.dshHome,
        }),
      ).rejects.toMatchObject({ code: "dsh-source-invalid" });
    } finally {
      await dispose(value);
    }
  });

  it("exports its custom error type for actionable source failures", () => {
    const error = new DshPresetError("dsh-source-invalid", "fixture failure");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("dsh-source-invalid");
    expect(error.message).toBe("fixture failure");
  });
});
