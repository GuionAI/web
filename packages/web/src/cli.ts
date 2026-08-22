#!/usr/bin/env node
import { createSearchService, credentialsFromEnvironment } from "./index.js";
import { runCli } from "./runner.js";

const exitCode = await runCli(
  process.argv,
  { service: createSearchService(), credentials: credentialsFromEnvironment },
  { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
);
process.exitCode = exitCode;
