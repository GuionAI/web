#!/usr/bin/env node
import { createWebService, credentialsFromEnvironment } from "./index.js";
import { runCli } from "./runner.js";

const exitCode = await runCli(
  process.argv,
  { service: createWebService(), credentials: credentialsFromEnvironment },
  { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
);
process.exitCode = exitCode;
