import { createHash } from "node:crypto";
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
export const MANAGED_PRESET_IDS = [
  "standard",
  "ptc",
  "cordis",
  "minimal",
] as const;
export type ManagedPresetId = (typeof MANAGED_PRESET_IDS)[number];

/** The file which establishes that a preset directory is replaceable by Guion. */
export const MANAGED_MARKER_FILE = ".guion-managed.json" as const;
const MANAGED_MARKER_VERSION = 1 as const;
const MANAGED_BY = "@guionai/web" as const;
const USER_PRESET_DIRECTORY = ".agent-presets" as const;

/**
 * Explicit filesystem seams used by tests and by callers embedding the CLI.
 * When omitted, sync and doctor discover the installed `dsh` executable and
 * use the same DSH_HOME precedence as the official harness.
 */
export type DshRenamePhase =
  | "before-backup-rename"
  | "after-backup-rename"
  | "before-install-rename"
  | "after-install-rename"
  | "before-backup-delete";

export interface DshRenameEvent {
  readonly id: ManagedPresetId;
  readonly phase: DshRenamePhase;
  readonly target: string;
  readonly staged?: string;
  readonly backup?: string;
}

export interface DshSyncHooks {
  /** A test-owned seam for deterministic filesystem races and failures. */
  readonly beforeRename?:
    | ((event: DshRenameEvent) => void | Promise<void>)
    | undefined;
}

export interface DshPathOverrides {
  dshExecutable?: string;
  dshHome?: string;
  sourcePackageRoot?: string;
  sourcePresetRoot?: string;
  userPresetRoot?: string;
  environment?: NodeJS.ProcessEnv;
  hooks?: DshSyncHooks;
}

export interface DshRuntimeInfo {
  readonly dshExecutable?: string;
  readonly dshHome: string;
  readonly userPresetRoot: string;
  readonly sourcePackageRoot: string;
  readonly sourcePresetRoot: string;
  readonly sourcePackageName: typeof OFFICIAL_PRESET_PACKAGE;
  readonly sourcePackageVersion: typeof SUPPORTED_DSH_VERSION;
  readonly sourceIdentity: string;
}

export interface DshSyncResult {
  readonly runtime: DshRuntimeInfo;
  readonly ids: readonly ManagedPresetId[];
  readonly replaced: readonly ManagedPresetId[];
  readonly created: readonly ManagedPresetId[];
}

export interface DshDoctorPreset {
  readonly id: ManagedPresetId;
  readonly status: "ok" | "missing" | "incomplete" | "conflict" | "stale";
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
  let resolvedExecutable = await canonicalPath(executable);
  // npm and pnpm expose `dsh` as a generated POSIX wrapper rather than a
  // symlink. Read the wrapper's absolute Node entry so discovery follows the
  // runtime actually selected by PATH.
  try {
    const launcher = await readFile(resolvedExecutable, "utf8");
    const suffix = "/node_modules/@deepseek-ai/dsh/lib/bin.js";
    const suffixAt = launcher.indexOf(suffix);
    if (suffixAt >= 0) {
      let tokenStart = suffixAt;
      while (tokenStart > 0 && !/\s|["'`]/.test(launcher[tokenStart - 1]!))
        tokenStart -= 1;
      const token = launcher.slice(tokenStart, suffixAt + suffix.length);
      resolvedExecutable = await canonicalPath(
        token.startsWith("/")
          ? token
          : join(
              dirname(resolvedExecutable),
              token.replace(/^\$basedir(?:_win)?\//, ""),
            ),
      );
    }
  } catch {
    // A direct JavaScript entry is handled by the normal ancestor walk.
  }
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

async function sourceIdentity(root: string, version: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`${OFFICIAL_PRESET_PACKAGE}\0${version}\0`);
  for (const file of await listFiles(root)) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(root, file)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
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
  id: ManagedPresetId,
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
    `${id}/agent.cordis.yml (managed)`,
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
  const identity = await sourceIdentity(discovered.presetRoot, version);
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
    sourceIdentity: identity,
  };
}

export async function resolveDshRuntime(
  options: DshPathOverrides = {},
): Promise<DshRuntimeInfo> {
  return resolveRuntime(options);
}

function markerFor(
  runtime: DshRuntimeInfo,
  id: ManagedPresetId,
): UnknownRecord {
  return {
    managedBy: MANAGED_BY,
    markerVersion: MANAGED_MARKER_VERSION,
    presetId: id,
    sourcePackage: runtime.sourcePackageName,
    sourcePackageVersion: runtime.sourcePackageVersion,
    sourceIdentity: runtime.sourceIdentity,
    sourcePreset: `${OFFICIAL_PRESET_PACKAGE}/presets/${id}`,
  };
}

function isManagedMarker(
  value: unknown,
  id: ManagedPresetId,
): value is UnknownRecord {
  return (
    isRecord(value) &&
    value.managedBy === MANAGED_BY &&
    value.markerVersion === MANAGED_MARKER_VERSION &&
    value.presetId === id
  );
}

async function readMarker(
  directory: string,
  id: ManagedPresetId,
): Promise<UnknownRecord | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(directory, MANAGED_MARKER_FILE), "utf8"),
    );
    return isManagedMarker(value, id) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function targetKind(
  root: string,
  id: ManagedPresetId,
): Promise<{
  kind: "missing" | "managed" | "conflict";
  marker?: UnknownRecord;
}> {
  const directory = join(root, id);
  let info;
  try {
    info = await lstat(directory);
  } catch {
    return { kind: "missing" };
  }
  if (!info.isDirectory()) return { kind: "conflict" };
  const marker = await readMarker(directory, id);
  return marker === undefined
    ? { kind: "conflict" }
    : { kind: "managed", marker };
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

async function stagePreset(
  stageRoot: string,
  sourceRoot: string,
  runtime: DshRuntimeInfo,
  id: ManagedPresetId,
): Promise<void> {
  const removeWeb = id !== "minimal";
  const validation = await validateSourceTree(sourceRoot, id, removeWeb);
  const sourceDirectory = join(sourceRoot, id);
  const stagedDirectory = join(stageRoot, id);
  await cp(sourceDirectory, stagedDirectory, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
  await writeFile(
    join(stagedDirectory, "agent.cordis.yml"),
    validation.transformedComposition,
    "utf8",
  );
  await writeFile(
    join(stagedDirectory, MANAGED_MARKER_FILE),
    `${JSON.stringify(markerFor(runtime, id), null, 2)}\n`,
    "utf8",
  );
}

type ManagedSnapshot = ReadonlyMap<string, Buffer>;

/**
 * Build the exact byte snapshot that a managed copy is allowed to contain.
 * The official composition is the one transformed by this integration; every
 * other source file is copied byte-for-byte.  The marker is generated by
 * Guion and is therefore deliberately excluded from the source snapshot.
 */
async function expectedManagedSnapshot(
  runtime: DshRuntimeInfo,
  id: ManagedPresetId,
): Promise<ManagedSnapshot> {
  const validation = await validateSourceTree(
    runtime.sourcePresetRoot,
    id,
    id !== "minimal",
  );
  const sourceDirectory = join(runtime.sourcePresetRoot, id);
  const expected = new Map<string, Buffer>();
  for (const file of await listFiles(sourceDirectory)) {
    if (file === MANAGED_MARKER_FILE) continue;
    expected.set(
      file,
      file === "agent.cordis.yml"
        ? Buffer.from(validation.transformedComposition)
        : await readFile(join(sourceDirectory, file)),
    );
  }
  return expected;
}

async function snapshotMismatch(
  runtime: DshRuntimeInfo,
  id: ManagedPresetId,
  directory: string,
): Promise<string | undefined> {
  return compareManagedSnapshot(
    await expectedManagedSnapshot(runtime, id),
    directory,
  );
}

async function compareManagedSnapshot(
  expected: ManagedSnapshot,
  directory: string,
): Promise<string | undefined> {
  const expectedFiles = new Set([...expected.keys(), MANAGED_MARKER_FILE]);
  const actualFiles = new Set(await listFiles(directory));
  for (const file of expectedFiles)
    if (!actualFiles.has(file)) return `managed file is missing: ${file}`;
  for (const file of actualFiles)
    if (!expectedFiles.has(file)) return `unexpected managed file: ${file}`;
  for (const [file, expectedBytes] of expected) {
    const actualBytes = await readFile(join(directory, file));
    if (
      actualBytes.length !== expectedBytes.length ||
      !actualBytes.equals(expectedBytes)
    )
      return `managed file differs from the official source: ${file}`;
  }
  return undefined;
}

async function managedTargetMatches(
  runtime: DshRuntimeInfo,
  id: ManagedPresetId,
  directory: string,
  expected?: ManagedSnapshot,
): Promise<boolean> {
  const marker = await readMarker(directory, id);
  if (
    marker === undefined ||
    marker.sourcePackage !== runtime.sourcePackageName ||
    marker.sourcePackageVersion !== runtime.sourcePackageVersion ||
    marker.sourceIdentity !== runtime.sourceIdentity
  )
    return false;
  try {
    return (
      (await compareManagedSnapshot(
        expected ?? (await expectedManagedSnapshot(runtime, id)),
        directory,
      )) === undefined
    );
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function invokeRenameHook(
  options: DshPathOverrides,
  event: DshRenameEvent,
): Promise<void> {
  await options.hooks?.beforeRename?.(event);
}

export async function syncManagedPresets(
  options: DshPathOverrides = {},
): Promise<DshSyncResult> {
  const runtime = await resolveRuntime(options);
  return syncManagedPresetsLocked(runtime, options);
}

async function syncManagedPresetsLocked(
  runtime: DshRuntimeInfo,
  options: DshPathOverrides,
): Promise<DshSyncResult> {
  // Validate every source tree before creating the user root or staging files.
  for (const id of MANAGED_PRESET_IDS)
    await validateSourceTree(runtime.sourcePresetRoot, id, id !== "minimal");
  await assertUserRootSafe(runtime.userPresetRoot);

  const existing = new Map<
    ManagedPresetId,
    Awaited<ReturnType<typeof targetKind>>
  >();
  for (const id of MANAGED_PRESET_IDS) {
    const result = await targetKind(runtime.userPresetRoot, id);
    existing.set(id, result);
    if (result.kind === "conflict")
      throw new DshPresetError(
        "dsh-preset-conflict",
        `refusing to overwrite unmarked same-id preset ${join(runtime.userPresetRoot, id)}; move it or add a Guion marker explicitly`,
      );
  }

  await mkdir(runtime.userPresetRoot, { recursive: true });
  const stageRoot = await mkdtemp(join(runtime.dshHome, ".guion-dsh-presets-"));
  const snapshots = new Map<ManagedPresetId, ManagedSnapshot>();
  const backups: Array<{
    id: ManagedPresetId;
    target: string;
    backup: string;
  }> = [];
  const installed: Array<{
    id: ManagedPresetId;
    target: string;
    expected: ManagedSnapshot;
  }> = [];
  const replaced: ManagedPresetId[] = [];
  const created: ManagedPresetId[] = [];
  let backupNonce = 0;
  try {
    for (const id of MANAGED_PRESET_IDS) {
      snapshots.set(id, await expectedManagedSnapshot(runtime, id));
      await stagePreset(stageRoot, runtime.sourcePresetRoot, runtime, id);
    }

    // Recheck all targets after staging and before the first replacement. A
    // failed preflight therefore cannot leave a partially refreshed roster.
    for (const id of MANAGED_PRESET_IDS) {
      const result = await targetKind(runtime.userPresetRoot, id);
      if (result.kind === "conflict" || result.kind !== existing.get(id)!.kind)
        throw new DshPresetError(
          "dsh-preset-conflict",
          `same-id preset changed while preparing ${join(runtime.userPresetRoot, id)}; refusing to overwrite it`,
        );
    }

    for (const id of MANAGED_PRESET_IDS) {
      const target = join(runtime.userPresetRoot, id);
      const expected = snapshots.get(id)!;
      // Revalidate ownership immediately before each rename. The hook is
      // intentionally called after this check so tests can deterministically
      // model a race in the tiny rename window and exercise post-rename
      // marker verification.
      const current = await targetKind(runtime.userPresetRoot, id);
      if (current.kind !== existing.get(id)!.kind)
        throw new DshPresetError(
          "dsh-preset-conflict",
          `same-id preset changed before replacement ${target}; refusing to overwrite it`,
        );
      if (current.kind === "managed") {
        const backup = join(
          runtime.userPresetRoot,
          `.guion-dsh-backup-${id}-${process.pid}-${Date.now()}-${backupNonce++}`,
        );
        await invokeRenameHook(options, {
          id,
          phase: "before-backup-rename",
          target,
          staged: join(stageRoot, id),
          backup,
        });
        await rename(target, backup);
        if ((await readMarker(backup, id)) === undefined) {
          // A same-ID directory may have been swapped after the ownership
          // check. Restore it immediately and never make it deletable.
          try {
            if (!(await pathExists(target))) await rename(backup, target);
          } catch {
            // Keep the unknown directory at the backup path if restoration is
            // itself raced; rollback below will also leave it untouched.
          }
          throw new DshPresetError(
            "dsh-preset-conflict",
            `same-id preset changed during replacement ${target}; unknown data was preserved`,
          );
        }
        backups.push({ id, target, backup });
        await invokeRenameHook(options, {
          id,
          phase: "after-backup-rename",
          target,
          staged: join(stageRoot, id),
          backup,
        });
        replaced.push(id);
      } else {
        created.push(id);
      }
      const staged = join(stageRoot, id);
      await invokeRenameHook(options, {
        id,
        phase: "before-install-rename",
        target,
        staged,
        backup: backups.at(-1)?.id === id ? backups.at(-1)?.backup : undefined,
      });
      if ((await targetKind(runtime.userPresetRoot, id)).kind !== "missing")
        throw new DshPresetError(
          "dsh-preset-conflict",
          `same-id preset appeared before install ${target}; refusing to overwrite it`,
        );
      await rename(staged, target);
      installed.push({ id, target, expected });
      if (!(await managedTargetMatches(runtime, id, target, expected)))
        throw new DshPresetError(
          "dsh-preset-incomplete",
          `managed preset install did not match the expected source snapshot: ${id}`,
        );
      await invokeRenameHook(options, {
        id,
        phase: "after-install-rename",
        target,
        backup: backups.at(-1)?.id === id ? backups.at(-1)?.backup : undefined,
      });
    }

    // Validate every backup before deleting any of them. If cleanup itself
    // fails, retaining a verified Guion-managed backup is safe and recoverable.
    for (const backup of backups)
      await invokeRenameHook(options, {
        id: backup.id,
        phase: "before-backup-delete",
        target: backup.target,
        backup: backup.backup,
      });
    for (const backup of backups) {
      if ((await readMarker(backup.backup, backup.id)) === undefined)
        throw new DshPresetError(
          "dsh-preset-conflict",
          `backup for ${backup.id} is no longer Guion-managed; preserving it at ${backup.backup}`,
        );
    }
    for (const backup of backups) {
      try {
        await rm(backup.backup, { recursive: true, force: true });
      } catch {
        // A cleanup failure must not turn a successful, complete roster into
        // a destructive rollback. The verified backup remains recoverable.
      }
    }
    return { runtime, ids: MANAGED_PRESET_IDS, replaced, created };
  } catch (error) {
    // Remove only targets that still exactly match this transaction's staged
    // snapshot, then restore backups. Unknown data is never deleted.
    for (const entry of [...installed].reverse()) {
      try {
        if (
          await managedTargetMatches(
            runtime,
            entry.id,
            entry.target,
            entry.expected,
          )
        )
          await rm(entry.target, { recursive: true, force: true });
      } catch {
        // Leave anything that cannot be proven to be ours untouched.
      }
    }
    for (const backup of [...backups].reverse()) {
      try {
        if (await pathExists(backup.target)) {
          if (await managedTargetMatches(runtime, backup.id, backup.target))
            await rm(backup.target, { recursive: true, force: true });
          else continue;
        }
        if (await pathExists(backup.backup))
          await rename(backup.backup, backup.target);
      } catch {
        // Preserve both paths when restoration is not safe.
      }
    }
    throw error;
  } finally {
    try {
      await rm(stageRoot, { recursive: true, force: true });
    } catch {
      // Staged data is disposable; never mask the sync result or error.
    }
  }
}

async function inspectManagedPreset(
  runtime: DshRuntimeInfo,
  id: ManagedPresetId,
): Promise<DshDoctorPreset> {
  const directory = join(runtime.userPresetRoot, id);
  let info;
  try {
    info = await lstat(directory);
  } catch {
    return {
      id,
      status: "missing",
      detail: "managed preset directory is missing",
    };
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    return {
      id,
      status: "conflict",
      detail: "same-id path is not a directory",
    };
  let markerValue: unknown;
  try {
    markerValue = JSON.parse(
      await readFile(join(directory, MANAGED_MARKER_FILE), "utf8"),
    );
  } catch {
    return {
      id,
      status: "conflict",
      detail: `missing or invalid ${MANAGED_MARKER_FILE}`,
    };
  }
  if (!isManagedMarker(markerValue, id))
    return { id, status: "conflict", detail: "directory is not Guion-managed" };
  if (
    markerValue.sourcePackage !== runtime.sourcePackageName ||
    markerValue.sourcePackageVersion !== runtime.sourcePackageVersion ||
    markerValue.sourceIdentity !== runtime.sourceIdentity
  )
    return {
      id,
      status: "stale",
      detail: "managed copy was generated from a different official source",
    };
  try {
    const mismatch = await snapshotMismatch(runtime, id, directory);
    if (mismatch !== undefined)
      return { id, status: "incomplete", detail: mismatch };
  } catch (error) {
    return {
      id,
      status: "incomplete",
      detail:
        error instanceof Error ? error.message : "managed files are incomplete",
    };
  }
  return { id, status: "ok" };
}

export async function inspectManagedPresets(
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
  for (const id of MANAGED_PRESET_IDS) {
    try {
      await validateSourceTree(runtime.sourcePresetRoot, id, id !== "minimal");
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  await assertUserRootSafe(runtime.userPresetRoot).catch((error) => {
    issues.push(error instanceof Error ? error.message : String(error));
  });
  if (issues.length === 0) {
    for (const id of MANAGED_PRESET_IDS) {
      const preset = await inspectManagedPreset(runtime, id);
      presets.push(preset);
      if (preset.status !== "ok")
        issues.push(`${id}: ${preset.detail ?? preset.status}`);
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

export async function doctorManagedPresets(
  options: DshPathOverrides = {},
): Promise<DshDoctorReport> {
  return inspectManagedPresets(options);
}

export function formatDshDoctor(report: DshDoctorReport): string {
  const lines = [`DSH doctor: ${report.ok ? "OK" : "FAILED"}`];
  if (report.runtime !== undefined) {
    lines.push(
      `Source: ${report.runtime.sourcePackageName}@${report.runtime.sourcePackageVersion}`,
    );
    lines.push(`Source identity: ${report.runtime.sourceIdentity}`);
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
    result.created.length === MANAGED_PRESET_IDS.length
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
  return `DSH managed presets ${action} from ${result.runtime.sourcePackageName}@${result.runtime.sourcePackageVersion}.\nPreset root: ${result.runtime.userPresetRoot}\n`;
}
