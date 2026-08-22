import { Command } from "commander";

import { formatSearchResults, type SearchCredentials, type SearchInput, type SearchResponse } from "@guionai/web-core";

export type SearchService = {
  search(input: SearchInput): Promise<SearchResponse>;
};

export type ProgramDependencies = {
  service: SearchService;
  credentials: () => SearchCredentials;
  writeOut?: (text: string) => void;
};

export function createProgram(dependencies: ProgramDependencies): Command {
  const program = new Command();
  program
    .name("web")
    .description("Search the web and fetch web pages")
    .showSuggestionAfterError(false)
    .showHelpAfterError(false)
    .addCommand(createSearchCommand(dependencies));
  return program;
}

function createSearchCommand(dependencies: ProgramDependencies): Command {
  const writeOut = dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("search")
    .description("Search the web")
    .argument("<query>", "One search query")
    .option("--json", "Output the structured result as JSON")
    .option("--provider <provider>", "Search provider: exa or brave")
    .action(async (query: string, options: { json?: boolean; provider?: string }, command: Command) => {
      const result = await dependencies.service.search({
        query,
        provider: options.provider,
        credentials: dependencies.credentials(),
      });
      if (options.json) {
        writeOut(JSON.stringify(result) + "\n");
        return;
      }
      writeOut(formatSearchResults(result.results));
    });
}
