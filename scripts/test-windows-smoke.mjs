#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "guionai-windows-smoke-regression-"));
const script = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "windows-smoke.mjs",
);
const preload = join(root, "force-win32.mjs");
const fakePnpm = join(root, "fake-pnpm.mjs");
const invocationLog = join(root, "pnpm-invocation.log");

try {
  await writeFile(
    preload,
    'Object.defineProperty(process, "platform", { value: "win32" });\n',
  );
  await writeFile(
    fakePnpm,
    'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.WINDOWS_SMOKE_LOG, process.argv.slice(2).join(" "));\nprocess.exit(42);\n',
  );
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", preload, script], {
      env: {
        ...process.env,
        npm_execpath: fakePnpm,
        WINDOWS_SMOKE_LOG: invocationLog,
        PATH: root,
        TEMP: root,
        TMP: root,
      },
    }),
  );
  const invocation = await readFile(invocationLog, "utf8");
  assert.match(invocation, /^pack --pack-destination /);
  console.log("Windows smoke runs pnpm through npm_execpath");
} finally {
  await rm(root, { recursive: true, force: true });
}
