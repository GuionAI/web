import {
  createProgram,
  type WebCredentials,
  type WebService,
} from "./program.js";

export type CliDependencies = {
  service: WebService;
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
  program.configureOutput({ writeOut: output.stdout, writeErr: output.stderr });
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    output.stderr(
      `${error instanceof Error ? error.message : "web search failed"}\n`,
    );
    return 1;
  }
}
