import { Command } from "commander";

import { createMcpCommand } from "./mcp.js";

import {
  formatSearchResults,
  type DocsFetchInput,
  type DocsFetchResult,
  type DocsLibrary,
  type DocsResolveInput,
  type DocsResolveResult,
  type FetchInput,
  type FetchResult,
  type SearchCredentials,
  type SearchInput,
  type SearchResponse,
  type SGraphInput,
  type SGraphResult,
} from "@guionai/web-core";

export type WebCredentials = SearchCredentials & { context7ApiKey?: string };

export type WebService = {
  search(input: SearchInput): Promise<SearchResponse>;
  fetch(input: FetchInput, signal?: AbortSignal): Promise<FetchResult>;
  docsResolve(input: DocsResolveInput): Promise<DocsResolveResult>;
  docsFetch(input: DocsFetchInput): Promise<DocsFetchResult>;
  sgraphSearch(input: SGraphInput): Promise<SGraphResult>;
};

export type ProgramDependencies = {
  service: WebService;
  credentials: () => WebCredentials;
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
    .addCommand(createFetchCommand(dependencies))
    .addCommand(createDocsCommand(dependencies))
    .addCommand(createSGraphCommand(dependencies))
    .addCommand(createMcpCommand(dependencies));
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

function createSGraphCommand(dependencies: ProgramDependencies): Command {
  const writeOut = dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("sgraph")
    .description("Search code across public repositories via Sourcegraph")
    .argument("<query>", "Sourcegraph public code-search query")
    .option("-c, --count <count>", "Max results to return (10-20, default 10)", parseSgraphInteger, 10)
    .option("-C, --context <context>", "Lines of context around each match", parseSgraphInteger, 10)
    .option("-t, --timeout <seconds>", "Request timeout in seconds (max 120, 0 = no timeout)", parseSgraphInteger, 0)
    .option("--json", "Output the structured result as JSON")
    .action(async (query: string, options: { count: number; context: number; timeout: number; json?: boolean }) => {
      const result = await dependencies.service.sgraphSearch({
        query,
        count: options.count,
        context: options.context,
        timeout: options.timeout,
      });
      if (options.json) {
        writeOut(JSON.stringify(result) + "\n");
        return;
      }
      writeOut(result.content);
    });
}

function createDocsCommand(dependencies: ProgramDependencies): Command {
  return new Command("docs")
    .description("Library documentation via Context7")
    .addCommand(createDocsResolveCommand(dependencies))
    .addCommand(createDocsFetchCommand(dependencies));
}

function createDocsResolveCommand(dependencies: ProgramDependencies): Command {
  const writeOut = dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("resolve")
    .description("Resolve a library name to Context7 IDs")
    .argument("<query>", "Library name or package query")
    .option("--json", "Output the structured result as JSON")
    .action(async (query: string, options: { json?: boolean }) => {
      const result = await dependencies.service.docsResolve({ query, credentials: dependencies.credentials() });
      if (options.json) {
        writeOut(JSON.stringify(result) + "\n");
        return;
      }
      writeOut(formatLibraries(result.libraries));
    });
}

function createDocsFetchCommand(dependencies: ProgramDependencies): Command {
  const writeOut = dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("fetch")
    .description("Fetch documentation for a resolved Context7 library ID")
    .argument("<library-id>", "Context7 library ID returned by docs resolve")
    .argument("[topic]", "Optional documentation topic")
    .option("--tokens <tokens>", "Token budget (0 = backend default)", parseInteger, 0)
    .option("--json", "Output the structured result as JSON")
    .action(async (libraryID: string, topic: string | undefined, options: { tokens?: number; json?: boolean }) => {
      const result = await dependencies.service.docsFetch({
        library_id: libraryID,
        topic,
        tokens: options.tokens,
        credentials: dependencies.credentials(),
      });
      if (options.json) {
        writeOut(JSON.stringify(result) + "\n");
        return;
      }
      writeOut(result.content);
    });
}

function parseInteger(value: string): number {
  const integer = Number(value);
  if (!Number.isInteger(integer)) throw new Error("--tokens must be an integer");
  return integer;
}

function parseSgraphInteger(value: string): number {
  const integer = Number(value);
  if (!Number.isInteger(integer)) throw new Error("Sourcegraph options must be integers");
  return integer;
}

function formatLibraries(libraries: DocsLibrary[]): string {
  let output = `Found ${libraries.length} libraries:\n\n`;
  for (const [index, library] of libraries.entries()) {
    output += `${index + 1}. ${library.title}\n`;
    output += `   ID: ${library.id}\n`;
    output += `   Trust: ${library.trust_score.toFixed(1)}   Snippets: ${library.total_snippets}\n`;
    if (library.versions && library.versions.length > 0) output += `   Versions: ${library.versions.join(", ")}\n`;
    output += `   ${library.description}\n\n`;
  }
  return output;
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
