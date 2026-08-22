import { Command } from "commander";

import {
  formatSearchResults,
  type FetchInput,
  type FetchResult,
  type SearchCredentials,
  type SearchInput,
  type SearchResponse,
} from "@guionai/web-core";

export type WebService = {
  search(input: SearchInput): Promise<SearchResponse>;
  fetch(input: FetchInput, signal?: AbortSignal): Promise<FetchResult>;
};

export type ProgramDependencies = {
  service: WebService;
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
    .addCommand(createSearchCommand(dependencies))
    .addCommand(createFetchCommand(dependencies));
  return program;
}

function createSearchCommand(dependencies: ProgramDependencies): Command {
  const writeOut = dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("search")
    .description("Search the web")
    .argument("<query>", "One search query")
    .option("--json", "Output the structured result as JSON")
    .option("--provider <provider>", "Search provider: exa or brave")
    .action(async (query: string, options: { json?: boolean; provider?: string }) => {
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

function createFetchCommand(dependencies: ProgramDependencies): Command {
  const writeOut = dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("fetch")
    .description("Fetch a static, SSR, or pre-rendered page as Markdown")
    .argument("<url>", "HTTP or HTTPS URL")
    .option("--tree", "Show the heading tree")
    .option("-s, --section <id>", "Read one heading section")
    .option("--full", "Return full content instead of automatic tree navigation")
    .option("--tree-threshold <characters>", "Auto-tree threshold", Number)
    .option("--json", "Output the structured result as JSON")
    .action(async (
      url: string,
      options: { tree?: boolean; section?: string; full?: boolean; treeThreshold?: number; json?: boolean },
    ) => {
      const result = await dependencies.service.fetch({
        url,
        tree: options.tree,
        section_id: options.section,
        full: options.full,
        tree_threshold: options.treeThreshold,
      });
      if (options.json) {
        writeOut(JSON.stringify(result) + "\n");
        return;
      }
      writeOut(result.content);
    });
}
