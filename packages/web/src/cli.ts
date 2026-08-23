#!/usr/bin/env node
import { createWebOperations } from "@guionai/web-core";
import { credentialsFromEnvironment } from "./runtime.js";
import { runCli } from "./runner.js";

const exitCode = await runCli(
  process.argv,
  {
    operations: createWebOperations(),
    credentials: credentialsFromEnvironment,
  },
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
);
process.exitCode = exitCode;
