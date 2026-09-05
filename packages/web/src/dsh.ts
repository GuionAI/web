import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire as createNodeRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseDocument, type Document } from "yaml";

export const SUPPORTED_DSH_VERSION = "0.1.2-rc.1" as const;
export const OFFICIAL_PRESET_PACKAGE =
  "@deepseek-ai/dsh-agent-presets" as const;
export const COMPATIBLE_PRESET_IDS = [
  "standard",
  "ptc",
  "cordis",
  "minimal",
] as const;
export type CompatiblePresetId = (typeof COMPATIBLE_PRESET_IDS)[number];

const USER_PRESET_DIRECTORY = ".agent-presets" as const;

/**
 * Explicit filesystem seams used by tests and by callers embedding the CLI.
 * When omitted, sync and doctor discover the installed `dsh` executable and
 * use the same DSH_HOME precedence as the official harness.
 */
export interface DshPathOverrides {
  dshExecutable?: string;
  dshHome?: string;
  sourcePackageRoot?: string;
  sourcePresetRoot?: string;
  userPresetRoot?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface DshSyncOptions {
  readonly yes?: boolean;
  readonly confirmOverwrite?: (
    ids: readonly CompatiblePresetId[],
  ) => boolean | Promise<boolean>;
}

export interface DshRuntimeInfo {
  readonly dshExecutable?: string;
  readonly dshHome: string;
  readonly userPresetRoot: string;
  readonly sourcePackageRoot: string;
  readonly sourcePresetRoot: string;
  readonly sourcePackageName: typeof OFFICIAL_PRESET_PACKAGE;
  readonly sourcePackageVersion: typeof SUPPORTED_DSH_VERSION;
}

export interface DshSyncResult {
  readonly runtime: DshRuntimeInfo;
  readonly ids: readonly CompatiblePresetId[];
  readonly replaced: readonly CompatiblePresetId[];
  readonly created: readonly CompatiblePresetId[];
}

export interface DshDoctorPreset {
  readonly id: CompatiblePresetId;
  readonly status: "ok" | "missing" | "conflict" | "stale";
  readonly detail?: string;
}

export interface DshDoctorReport {
  readonly ok: boolean;
  readonly runtime?: DshRuntimeInfo;
  readonly userPresetRoot?: string;
  readonly presets: readonly DshDoctorPreset[];
  readonly issues: readonly string[];
}

export class DshPresetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DshPresetError";
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\"))
    return join(homedir(), value.slice(2));
  return value;
}

function resolveHome(options: DshPathOverrides): string {
  const environment = options.environment ?? process.env;
  const configured = options.dshHome;
  const fromEnvironment = environment.DSH_HOME;
  return resolve(
    expandHomePath(
      configured ??
        (typeof fromEnvironment === "string" && fromEnvironment.trim() !== ""
          ? fromEnvironment
          : join(homedir(), ".dsh")),
    ),
  );
}

function findDshExecutables(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  try {
    const output = execFileSync("which", ["-a", "dsh"], {
      encoding: "utf8",
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [
      ...new Set(
        output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await (await import("node:fs/promises")).realpath(path);
  } catch {
    return resolve(path);
  }
}

async function packageRootForExecutable(executable: string): Promise<string> {
  const resolvedExecutable = await canonicalPath(executable);
  // npm and pnpm put generated wrappers in node_modules/.bin beside the
  // package they launch. This avoids depending on package-manager shim text.
  const adjacentPackage = resolve(
    dirname(resolvedExecutable),
    "..",
    "@deepseek-ai",
    "dsh",
  );
  if ((await readPackageManifest(adjacentPackage))?.name === "@deepseek-ai/dsh")
    return canonicalPath(adjacentPackage);

  // Direct JavaScript entries and symlinked bins resolve inside the package.
  let current = dirname(resolvedExecutable);
  while (true) {
    try {
      const manifest = JSON.parse(
        await readFile(join(current, "package.json"), "utf8"),
      ) as UnknownRecord;
      if (manifest.name === "@deepseek-ai/dsh") return current;
    } catch {
      // Keep walking until the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new DshPresetError(
    "dsh-runtime-unresolved",
    `could not resolve the installed DSH runtime package from ${executable}`,
  );
}

async function officialPresetPackageRoot(runtimeRoot: string): Promise<string> {
  const candidates = new Set<string>();
  const runtimeEntry = join(runtimeRoot, "lib", "bin.js");
  try {
    const require = createNodeRequire(pathToFileURL(runtimeEntry));
    candidates.add(
      dirname(require.resolve(`${OFFICIAL_PRESET_PACKAGE}/package.json`)),
    );
  } catch {
    // The runtime may be installed with a strict package manager layout. The
    // ancestor walk below handles the package-level node_modules roots.
  }
  // DSH's web application owns the agent-presets dependency in strict
  // package-manager layouts (including pnpm's virtual store). Resolve from
  // that sibling package as well as from the CLI entry itself.
  const runtimeScope = dirname(runtimeRoot);
  candidates.add(join(runtimeScope, "dsh-agent-presets"));
  for (const sibling of ["dsh-web-app", "dsh-app-boot"]) {
    try {
      const require = createNodeRequire(
        pathToFileURL(join(runtimeScope, sibling, "lib", "index.js")),
      );
      candidates.add(
        dirname(require.resolve(`${OFFICIAL_PRESET_PACKAGE}/package.json`)),
      );
    } catch {
      // Try the next package layout.
    }
  }
  let current = runtimeRoot;
  while (true) {
    candidates.add(
      join(current, "node_modules", "@deepseek-ai", "dsh-agent-presets"),
    );
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const existing: string[] = [];
  for (const candidate of candidates) {
    const manifest = await readPackageManifest(candidate);
    if (manifest?.name === OFFICIAL_PRESET_PACKAGE)
      existing.push(await canonicalPath(candidate));
  }
  const unique = [...new Set(existing)];
  if (unique.length === 0)
    throw new DshPresetError(
      "dsh-source-missing",
      `could not resolve ${OFFICIAL_PRESET_PACKAGE} from the installed DSH runtime at ${runtimeRoot}`,
    );
  if (unique.length > 1)
    throw new DshPresetError(
      "dsh-source-ambiguous",
      `found multiple installed ${OFFICIAL_PRESET_PACKAGE} packages (${unique.join(", ")}); provide one explicit source package path`,
    );
  return unique[0]!;
}

async function packageRootForPresetPath(presetRoot: string): Promise<string> {
  let current = resolve(presetRoot);
  try {
    const directory = (await stat(current)).isDirectory()
      ? current
      : dirname(current);
    current = directory;
  } catch {
    current = dirname(current);
  }
  while (true) {
    try {
      const manifest = JSON.parse(
        await readFile(join(current, "package.json"), "utf8"),
      ) as UnknownRecord;
      if (manifest.name === OFFICIAL_PRESET_PACKAGE) return current;
    } catch {
      // Keep walking until the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(presetRoot, "..");
}

async function readPackageManifest(
  packageRoot: string,
): Promise<UnknownRecord | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function discoverPresetPackage(options: DshPathOverrides): Promise<{
  packageRoot: string;
  presetRoot: string;
  executable?: string;
  manifest: UnknownRecord;
}> {
  const explicitPackageRoot = options.sourcePackageRoot;
  const explicitPresetRoot = options.sourcePresetRoot;
  let executable = options.dshExecutable;
  let packageRoot: string | undefined = explicitPackageRoot;

  if (packageRoot === undefined && explicitPresetRoot !== undefined)
    packageRoot = await packageRootForPresetPath(explicitPresetRoot);

  if (packageRoot === undefined) {
    const candidates =
      executable === undefined
        ? findDshExecutables(options.environment)
        : [executable];
    if (candidates.length === 0)
      throw new DshPresetError(
        "dsh-runtime-missing",
        "could not find the installed `dsh` executable; install DSH 0.1.2-rc.1 or provide a test-owned runtime path",
      );
    const canonicalCandidates = [
      ...new Set(await Promise.all(candidates.map(canonicalPath))),
    ];
    if (canonicalCandidates.length !== 1)
      throw new DshPresetError(
        "dsh-runtime-ambiguous",
        `found multiple installed dsh executables (${canonicalCandidates.join(", ")}); provide one explicit runtime path`,
      );
    executable = candidates[0];
    const runtimeRoot = await packageRootForExecutable(canonicalCandidates[0]!);
    packageRoot = await officialPresetPackageRoot(runtimeRoot);
  }

  packageRoot = resolve(packageRoot);
  const manifest = await readPackageManifest(packageRoot);
  if (manifest === undefined)
    throw new DshPresetError(
      "dsh-source-invalid",
      `source package at ${packageRoot} is missing a readable package.json manifest`,
    );
  const packageName = manifest.name;
  if (packageName !== OFFICIAL_PRESET_PACKAGE)
    throw new DshPresetError(
      "dsh-source-invalid",
      `source package at ${packageRoot} is ${String(packageName ?? "unnamed")}, expected ${OFFICIAL_PRESET_PACKAGE}`,
    );
  const presetRoot = resolve(
    explicitPresetRoot ?? join(packageRoot, "presets"),
  );
  return { packageRoot, presetRoot, executable, manifest };
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const next = join(prefix, entry.name);
    if (entry.isSymbolicLink())
      throw new DshPresetError(
        "dsh-source-invalid",
        `preset tree contains a symbolic link: ${next}`,
      );
    if (entry.isDirectory()) files.push(...(await listFiles(root, next)));
    else if (entry.isFile()) files.push(next);
    else
      throw new DshPresetError(
        "dsh-source-invalid",
        `preset tree contains a special file: ${next}`,
      );
  }
  return files;
}

function parseYaml(
  source: string,
  filename: string,
): {
  document: Document;
  value: unknown;
} {
  const document = parseDocument(source, {
    keepSourceTokens: true,
    logLevel: "silent",
  });
  if (document.errors.length > 0)
    throw new DshPresetError(
      "dsh-source-invalid",
      `${filename} is not valid YAML: ${document.errors[0]!.message}`,
    );
  try {
    return { document, value: document.toJS() };
  } catch (error) {
    throw new DshPresetError(
      "dsh-source-invalid",
      `${filename} could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function rowId(row: unknown): string | undefined {
  return isRecord(row) && typeof row.id === "string" ? row.id : undefined;
}

function validateComposition(
  source: string,
  filename: string,
  expectedWebRow: boolean,
): { document: Document; rows: unknown[]; webNode?: unknown } {
  const parsed = parseYaml(source, filename);
  const contents = parsed.document.contents as { items?: unknown[] } | null;
  if (!Array.isArray(parsed.value) || !Array.isArray(contents?.items))
    throw new DshPresetError(
      "dsh-source-invalid",
      `${filename} must contain a top-level list of composition rows`,
    );
  const rows = parsed.value;
  const items = contents.items;
  for (const [index, row] of rows.entries()) {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      typeof row.name !== "string"
    )
      throw new DshPresetError(
        "dsh-source-invalid",
        `${filename} row ${index + 1} must contain string id and name fields`,
      );
  }
  const webIndexes = rows
    .map((row, index) => (rowId(row) === "tool-web" ? index : -1))
    .filter((index) => index >= 0);
  if (expectedWebRow) {
    if (webIndexes.length !== 1)
      throw new DshPresetError(
        "dsh-source-invalid",
        `${filename} must contain exactly one top-level tool-web row`,
      );
    const row = rows[webIndexes[0]!]!;
    const rowKeys = isRecord(row) ? Object.keys(row) : [];
    if (
      !isRecord(row) ||
      rowKeys.length !== 3 ||
      !rowKeys.every((key) => ["id", "name", "config"].includes(key)) ||
      row.name !== "@deepseek-ai/dsh-tool-web" ||
      row.disabled === true ||
      !isRecord(row.config) ||
      Object.keys(row.config).length !== 2 ||
      row.config.fetch !== true ||
      row.config.searchTimeoutMs !== 60_000
    )
      throw new DshPresetError(
        "dsh-source-invalid",
        `${filename} tool-web row does not match the supported DSH 0.1.2-rc.1 shape`,
      );
  } else if (webIndexes.length !== 0) {
    throw new DshPresetError(
      "dsh-source-invalid",
      `${filename} minimal preset must omit the top-level tool-web row`,
    );
  }
  return {
    document: parsed.document,
    rows,
    webNode: webIndexes.length === 1 ? items[webIndexes[0]!] : undefined,
  };
}

async function validateSourceTree(
  sourceRoot: string,
  id: CompatiblePresetId,
  removeWeb: boolean,
): Promise<{
  composition: string;
  metadata: string;
  transformedComposition: string;
}> {
  const root = join(sourceRoot, id);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    throw new DshPresetError(
      "dsh-source-invalid",
      `official preset tree is missing: ${root}`,
    );
  }
  if (!rootStat.isDirectory())
    throw new DshPresetError(
      "dsh-source-invalid",
      `official preset path is not a directory: ${root}`,
    );
  const compositionPath = join(root, "agent.cordis.yml");
  const metadataPath = join(root, "preset.yml");
  const composition = await readFile(compositionPath, "utf8").catch(() => {
    throw new DshPresetError(
      "dsh-source-invalid",
      `official preset is missing ${id}/agent.cordis.yml`,
    );
  });
  const metadata = await readFile(metadataPath, "utf8").catch(() => {
    throw new DshPresetError(
      "dsh-source-invalid",
      `official preset is missing ${id}/preset.yml`,
    );
  });
  const parsed = validateComposition(
    composition,
    `${id}/agent.cordis.yml`,
    removeWeb,
  );
  const metadataParsed = parseYaml(metadata, `${id}/preset.yml`);
  if (!isRecord(metadataParsed.value))
    throw new DshPresetError(
      "dsh-source-invalid",
      `${id}/preset.yml must contain a mapping`,
    );

  let transformedComposition = composition;
  if (removeWeb) {
    const node = parsed.webNode as
      | { range?: readonly [number, number, number] }
      | undefined;
    if (node?.range === undefined)
      throw new DshPresetError(
        "dsh-source-invalid",
        `${id}/agent.cordis.yml tool-web row has no source range`,
      );
    let start = composition.lastIndexOf("\n", node.range[0] - 1) + 1;
    let end = composition.indexOf("\n", node.range[2]);
    if (end < 0) end = composition.length;
    else end += 1;
    transformedComposition =
      composition.slice(0, start) + composition.slice(end);
  }
  validateComposition(
    transformedComposition,
    `${id}/agent.cordis.yml (compatible)`,
    false,
  );
  return { composition, metadata, transformedComposition };
}

async function resolveRuntime(
  options: DshPathOverrides = {},
): Promise<DshRuntimeInfo> {
  const discovered = await discoverPresetPackage(options);
  const version = discovered.manifest.version;
  if (typeof version !== "string" || version.trim().length === 0)
    throw new DshPresetError(
      "dsh-source-invalid",
      `source package at ${discovered.packageRoot} is missing a package version`,
    );
  if (version !== SUPPORTED_DSH_VERSION)
    throw new DshPresetError(
      "dsh-source-unsupported",
      `unsupported ${OFFICIAL_PRESET_PACKAGE} version ${version}; this integration supports exactly ${SUPPORTED_DSH_VERSION}`,
    );
  if (
    !(await stat(discovered.presetRoot).catch(() => undefined))?.isDirectory()
  )
    throw new DshPresetError(
      "dsh-source-missing",
      `could not resolve the official preset root: ${discovered.presetRoot}`,
    );
  const dshHome = resolveHome(options);
  const userPresetRoot = resolve(
    options.userPresetRoot ?? join(dshHome, USER_PRESET_DIRECTORY),
  );
  return {
    dshExecutable: discovered.executable,
    dshHome,
    userPresetRoot,
    sourcePackageRoot: discovered.packageRoot,
    sourcePresetRoot: discovered.presetRoot,
    sourcePackageName: OFFICIAL_PRESET_PACKAGE,
    sourcePackageVersion: SUPPORTED_DSH_VERSION,
  };
}

export async function resolveDshRuntime(
  options: DshPathOverrides = {},
): Promise<DshRuntimeInfo> {
  return resolveRuntime(options);
}

async function assertUserRootSafe(root: string): Promise<void> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new DshPresetError(
        "dsh-home-invalid",
        `DSH user preset root is not a directory: ${root}`,
      );
  } catch (error) {
    if (error instanceof DshPresetError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function stagePreset(stageRoot: string, plan: PresetPlan): Promise<void> {
  const stagedDirectory = join(stageRoot, plan.id);
  await cp(plan.sourceDirectory, stagedDirectory, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
  await writeFile(
    join(stagedDirectory, "agent.cordis.yml"),
    plan.compatible.get("agent.cordis.yml")!,
  );
}

type PresetSnapshot = ReadonlyMap<string, Buffer>;
type PresetPlan = {
  readonly id: CompatiblePresetId;
  readonly sourceDirectory: string;
  readonly official: PresetSnapshot;
  readonly compatible: PresetSnapshot;
};
type TargetState = {
  readonly kind: "missing" | "official" | "compatible" | "conflict";
  readonly detail?: string;
};

async function buildPresetPlan(
  runtime: DshRuntimeInfo,
  id: CompatiblePresetId,
): Promise<PresetPlan> {
  const validation = await validateSourceTree(
    runtime.sourcePresetRoot,
    id,
    id !== "minimal",
  );
  const sourceDirectory = join(runtime.sourcePresetRoot, id);
  const official = new Map<string, Buffer>();
  for (const file of await listFiles(sourceDirectory)) {
    official.set(file, await readFile(join(sourceDirectory, file)));
  }
  const compatible = new Map(official);
  compatible.set(
    "agent.cordis.yml",
    Buffer.from(validation.transformedComposition),
  );
  return { id, sourceDirectory, official, compatible };
}

async function compareSnapshot(
  expected: PresetSnapshot,
  directory: string,
): Promise<string | undefined> {
  const expectedFiles = new Set(expected.keys());
  const actualFiles = new Set(await listFiles(directory));
  for (const file of expectedFiles)
    if (!actualFiles.has(file)) return `file is missing: ${file}`;
  for (const file of actualFiles)
    if (!expectedFiles.has(file)) return `unexpected file: ${file}`;
  for (const [file, expectedBytes] of expected) {
    const actualBytes = await readFile(join(directory, file));
    if (
      actualBytes.length !== expectedBytes.length ||
      !actualBytes.equals(expectedBytes)
    )
      return `file differs: ${file}`;
  }
  return undefined;
}

async function inspectTarget(
  plan: PresetPlan,
  directory: string,
): Promise<TargetState> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "missing" };
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    return { kind: "conflict", detail: "same-id path is not a directory" };
  try {
    const compatibleMismatch = await compareSnapshot(
      plan.compatible,
      directory,
    );
    if (compatibleMismatch === undefined) return { kind: "compatible" };
    if ((await compareSnapshot(plan.official, directory)) === undefined)
      return { kind: "official" };
    return { kind: "conflict", detail: compatibleMismatch };
  } catch (error) {
    return {
      kind: "conflict",
      detail: error instanceof Error ? error.message : "preset cannot be read",
    };
  }
}

export async function syncCompatiblePresets(
  paths: DshPathOverrides = {},
  options: DshSyncOptions = {},
): Promise<DshSyncResult> {
  const runtime = await resolveRuntime(paths);
  const plans = await Promise.all(
    COMPATIBLE_PRESET_IDS.map((id) => buildPresetPlan(runtime, id)),
  );
  await assertUserRootSafe(runtime.userPresetRoot);
  const states = new Map<CompatiblePresetId, TargetState>();
  const conflicts: CompatiblePresetId[] = [];
  for (const plan of plans) {
    const state = await inspectTarget(
      plan,
      join(runtime.userPresetRoot, plan.id),
    );
    states.set(plan.id, state);
    if (state.kind === "conflict") conflicts.push(plan.id);
  }
  const confirmed =
    conflicts.length === 0 ||
    options.yes === true ||
    (options.confirmOverwrite !== undefined &&
      (await options.confirmOverwrite(conflicts)));
  if (!confirmed)
    throw new DshPresetError(
      "dsh-confirmation-required",
      `refusing to overwrite modified same-id preset${conflicts.length === 1 ? "" : "s"} ${conflicts.join(", ")}; rerun interactively or pass --yes`,
    );

  await mkdir(runtime.userPresetRoot, { recursive: true });
  const stageRoot = await mkdtemp(join(runtime.dshHome, ".guion-dsh-presets-"));
  const replaced: CompatiblePresetId[] = [];
  const created: CompatiblePresetId[] = [];
  try {
    for (const plan of plans) await stagePreset(stageRoot, plan);
    for (const plan of plans) {
      const target = join(runtime.userPresetRoot, plan.id);
      const current = await inspectTarget(plan, target);
      if (
        current.kind === "conflict" &&
        states.get(plan.id)?.kind !== "conflict" &&
        options.yes !== true
      )
        throw new DshPresetError(
          "dsh-preset-conflict",
          `same-id preset changed after confirmation: ${target}`,
        );
      const staged = join(stageRoot, plan.id);
      if (current.kind === "missing") {
        await rename(staged, target);
        created.push(plan.id);
        continue;
      }
      const backup = join(
        runtime.userPresetRoot,
        `.guion-dsh-backup-${plan.id}-${process.pid}-${Date.now()}`,
      );
      await rename(target, backup);
      try {
        await rename(staged, target);
      } catch (error) {
        await rename(backup, target);
        throw error;
      }
      replaced.push(plan.id);
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
    return { runtime, ids: COMPATIBLE_PRESET_IDS, replaced, created };
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function inspectCompatiblePreset(
  plan: PresetPlan,
  userPresetRoot: string,
): Promise<DshDoctorPreset> {
  const state = await inspectTarget(plan, join(userPresetRoot, plan.id));
  if (state.kind === "compatible") return { id: plan.id, status: "ok" };
  if (state.kind === "missing")
    return { id: plan.id, status: "missing", detail: "preset is missing" };
  if (state.kind === "official")
    return {
      id: plan.id,
      status: "stale",
      detail: "official preset has not been converted; run web dsh sync",
    };
  return { id: plan.id, status: "conflict", detail: state.detail };
}

export async function inspectCompatiblePresets(
  options: DshPathOverrides = {},
): Promise<DshDoctorReport> {
  let runtime: DshRuntimeInfo;
  try {
    runtime = await resolveRuntime(options);
  } catch (error) {
    const home = resolveHome(options);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      userPresetRoot: resolve(
        options.userPresetRoot ?? join(home, USER_PRESET_DIRECTORY),
      ),
      presets: [],
      issues: [message],
    };
  }
  const presets: DshDoctorPreset[] = [];
  const issues: string[] = [];
  const plans: PresetPlan[] = [];
  for (const id of COMPATIBLE_PRESET_IDS) {
    try {
      plans.push(await buildPresetPlan(runtime, id));
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  await assertUserRootSafe(runtime.userPresetRoot).catch((error) => {
    issues.push(error instanceof Error ? error.message : String(error));
  });
  if (issues.length === 0) {
    for (const plan of plans) {
      const preset = await inspectCompatiblePreset(
        plan,
        runtime.userPresetRoot,
      );
      presets.push(preset);
      if (preset.status !== "ok")
        issues.push(`${plan.id}: ${preset.detail ?? preset.status}`);
    }
  }
  return {
    ok: issues.length === 0,
    runtime,
    userPresetRoot: runtime.userPresetRoot,
    presets,
    issues,
  };
}

export function formatDshDoctor(report: DshDoctorReport): string {
  const lines = [`DSH doctor: ${report.ok ? "OK" : "FAILED"}`];
  if (report.runtime !== undefined) {
    lines.push(
      `Source: ${report.runtime.sourcePackageName}@${report.runtime.sourcePackageVersion}`,
    );
    lines.push(`Preset root: ${report.runtime.userPresetRoot}`);
  } else if (report.userPresetRoot !== undefined)
    lines.push(`Preset root: ${report.userPresetRoot}`);
  for (const preset of report.presets)
    lines.push(
      `- ${preset.id}: ${preset.status}${preset.detail ? ` — ${preset.detail}` : ""}`,
    );
  for (const issue of report.issues) lines.push(`Issue: ${issue}`);
  return `${lines.join("\n")}\n`;
}

export function formatDshSync(result: DshSyncResult): string {
  const action =
    result.created.length === COMPATIBLE_PRESET_IDS.length
      ? "created all four presets"
      : [
          result.created.length > 0
            ? `created ${result.created.join(", ")}`
            : "",
          result.replaced.length > 0
            ? `refreshed ${result.replaced.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("; ");
  return `DSH compatible presets ${action} from ${result.runtime.sourcePackageName}@${result.runtime.sourcePackageVersion}.\nPreset root: ${result.runtime.userPresetRoot}\n`;
}
