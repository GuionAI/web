import { createProgram } from "./program.js";
import {
  FetchCapabilityError,
  type WebCredentials,
  type WebOperations,
} from "@guionai/web-core";

export type CliDependencies = {
  operations: WebOperations;
  credentials: () => WebCredentials;
};

export type CliOutput = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/** Runs the Commander adapter without mutating process exit state. */
export async function runCli(
  argv: string[],
  dependencies: CliDependencies,
  output: CliOutput,
): Promise<number> {
  const program = createProgram({ ...dependencies, writeOut: output.stdout });
  const fetchCommand = program.commands.find(
    (command) => command.name() === "fetch",
  );
  fetchCommand?.exitOverride();
  program.configureOutput({ writeOut: output.stdout, writeErr: output.stderr });
  fetchCommand?.configureOutput({
    writeOut: output.stdout,
    writeErr: output.stderr,
  });
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("commander.")
    )
      return error.code === "commander.helpDisplayed" ? 0 : 1;
    output.stderr(formatCliError(error));
    return 1;
  }
}

function formatCliError(error: unknown): string {
  if (!(error instanceof FetchCapabilityError))
    return `${error instanceof Error ? error.message : "web search failed"}\n`;
  if (error.code === "javascript_rendering_may_be_required") {
    return (
      "javascript_rendering_may_be_required: content may require JavaScript rendering\n" +
      "Retry: web fetch <url> --render=browser --wait=2000\n"
    );
  }
  if (error.code === "render_domain_not_allowed") {
    const hostname = error.details.blockedHostname
      ? ` (${error.details.blockedHostname})`
      : "";
    return (
      `render_domain_not_allowed${hostname}: increasing --wait will not help\n` +
      `Report a likely missing first-party or common-CDN domain: ${error.details.reportUrl}\n`
    );
  }
  return `${error.code}\n`;
}
