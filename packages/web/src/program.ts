import { Command } from "commander";

import { createMcpCommand } from "./mcp.js";
import { parseHttpPort, startHttpServer } from "./serve.js";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT } from "./serve.js";

import {
  FETCH_MODES,
  formatSearchResults,
  type DocsLibrary,
  type FetchMode,
  type LinksResult,
  type WebCredentials,
  type WebOperations,
} from "@guionai/web-core";

export type ProgramDependencies = {
  operations: WebOperations;
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
    .addCommand(createLinksCommand(dependencies))
    .addCommand(createDocsCommand(dependencies))
    .addCommand(createSGraphCommand(dependencies))
    .addCommand(createServeCommand(dependencies))
    .addCommand(createMcpCommand(dependencies));
  return program;
}

function createServeCommand(dependencies: ProgramDependencies): Command {
  const writeOut =
    dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("serve")
    .description("Serve all web research operations over HTTP")
    .option("--host <hostname>", "HTTP listen hostname", DEFAULT_HTTP_HOST)
    .option(
      "--port <port>",
      "HTTP listen port",
      parseHttpPort,
      DEFAULT_HTTP_PORT,
    )
    .action((options: { host: string; port: number }) => {
      startHttpServer(
        {
          operations: dependencies.operations,
          credentials: dependencies.credentials,
        },
        {
          hostname: options.host,
          port: options.port,
          onListening: ({ hostname, port }) =>
            writeOut(
              `Guion Web HTTP service listening on ${hostname}:${port}\n`,
            ),
        },
      );
    });
}

function createSearchCommand(dependencies: ProgramDependencies): Command {
  const writeOut =
    dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("search")
    .description("Search the web")
    .argument("<query>", "One search query")
    .option("--json", "Output the structured result as JSON")
    .option(
      "--provider <provider>",
      "Search provider: exa, brave, deepseek, or kepos-bridge",
    )
    .action(
      async (query: string, options: { json?: boolean; provider?: string }) => {
        const result = await dependencies.operations.search({
          query,
          provider: options.provider,
          credentials: dependencies.credentials(),
        });
        if (options.json) {
          writeOut(JSON.stringify(result) + "\n");
          return;
        }
        writeOut(formatSearchResults(result.results));
      },
    );
}

function createSGraphCommand(dependencies: ProgramDependencies): Command {
  const writeOut =
    dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("sgraph")
    .description("Search code across public repositories via Sourcegraph")
    .argument("<query>", "Sourcegraph public code-search query")
    .option(
      "-c, --count <count>",
      "Max results to return (10-20, default 10)",
      parseSgraphInteger,
      10,
    )
    .option(
      "-C, --context <context>",
      "Lines of context around each match",
      parseSgraphInteger,
      10,
    )
    .option(
      "-t, --timeout <seconds>",
      "Request timeout in seconds (max 120, 0 = no timeout)",
      parseSgraphInteger,
      0,
    )
    .option("--json", "Output the structured result as JSON")
    .action(
      async (
        query: string,
        options: {
          count: number;
          context: number;
          timeout: number;
          json?: boolean;
        },
      ) => {
        const result = await dependencies.operations.sgraphSearch({
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
      },
    );
}

function createDocsCommand(dependencies: ProgramDependencies): Command {
  return new Command("docs")
    .description("Library documentation via Context7")
    .addCommand(createDocsResolveCommand(dependencies))
    .addCommand(createDocsFetchCommand(dependencies));
}

function createDocsResolveCommand(dependencies: ProgramDependencies): Command {
  const writeOut =
    dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("resolve")
    .description("Resolve a library name to Context7 IDs")
    .argument("<query>", "Library name or package query")
    .option("--json", "Output the structured result as JSON")
    .action(async (query: string, options: { json?: boolean }) => {
      const result = await dependencies.operations.docsResolve({
        query,
        credentials: dependencies.credentials(),
      });
      if (options.json) {
        writeOut(JSON.stringify(result) + "\n");
        return;
      }
      writeOut(formatLibraries(result.libraries));
    });
}

function createDocsFetchCommand(dependencies: ProgramDependencies): Command {
  const writeOut =
    dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("fetch")
    .description("Fetch documentation for a resolved Context7 library ID")
    .argument("<library-id>", "Context7 library ID returned by docs resolve")
    .argument("[topic]", "Optional documentation topic")
    .option(
      "--tokens <tokens>",
      "Token budget (0 = backend default)",
      parseInteger,
      0,
    )
    .option("--json", "Output the structured result as JSON")
    .action(
      async (
        libraryID: string,
        topic: string | undefined,
        options: { tokens?: number; json?: boolean },
      ) => {
        const result = await dependencies.operations.docsFetch({
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
      },
    );
}

function parseInteger(value: string): number {
  const integer = Number(value);
  if (!Number.isInteger(integer))
    throw new Error("--tokens must be an integer");
  return integer;
}

function parseSgraphInteger(value: string): number {
  const integer = Number(value);
  if (!Number.isInteger(integer))
    throw new Error("Sourcegraph options must be integers");
  return integer;
}

function formatLibraries(libraries: DocsLibrary[]): string {
  let output = `Found ${libraries.length} libraries:\n\n`;
  for (const [index, library] of libraries.entries()) {
    output += `${index + 1}. ${library.title}\n`;
    output += `   ID: ${library.id}\n`;
    output += `   Trust: ${library.trust_score.toFixed(1)}   Snippets: ${library.total_snippets}\n`;
    if (library.versions && library.versions.length > 0)
      output += `   Versions: ${library.versions.join(", ")}\n`;
    output += `   ${library.description}\n\n`;
  }
  return output;
}

function createFetchCommand(dependencies: ProgramDependencies): Command {
  const writeOut =
    dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("fetch")
    .description("Fetch a static, SSR, or pre-rendered page as Markdown")
    .argument("<url>", "HTTP or HTTPS URL")
    .option("--render <renderer>", "Rendering mode: http (default) or browser")
    .option(
      "--wait <milliseconds>",
      "Required post-load wait for --render browser (0-30000)",
      Number,
    )
    .option(
      "--mode <mode>",
      "Navigation mode: auto (default), full, or tree",
      parseFetchMode,
    )
    .option("-s, --section <id>", "Read one heading section")
    .option("--json", "Output the structured result as JSON")
    .action(
      async (
        url: string,
        options: {
          render?: "http" | "browser";
          wait?: number;
          mode?: FetchMode;
          section?: string;
          json?: boolean;
        },
      ) => {
        validateCliNavigation(options.mode, options.section);
        const input = {
          url,
          ...(options.render !== undefined ? { render: options.render } : {}),
          ...(options.wait !== undefined ? { waitMs: options.wait } : {}),
          ...(options.mode !== undefined ? { mode: options.mode } : {}),
          ...(options.section !== undefined
            ? { section_id: options.section }
            : {}),
        };
        const result = await dependencies.operations.fetch(input);
        if (options.json) {
          writeOut(JSON.stringify(result) + "\n");
          return;
        }
        writeOut(result.content);
      },
    );
}

function parseFetchMode(value: string): FetchMode {
  if (!FETCH_MODES.includes(value as FetchMode))
    throw new Error("--mode must be one of auto, full, or tree");
  return value as FetchMode;
}

function validateCliNavigation(
  mode: FetchMode | undefined,
  section: string | undefined,
): void {
  if (section !== undefined && section.trim() === "")
    throw new Error("--section must be a non-empty string");
  if (section !== undefined && mode !== undefined && mode !== "auto")
    throw new Error('--section is only valid with --mode "auto"');
}

function createLinksCommand(dependencies: ProgramDependencies): Command {
  const writeOut =
    dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
  return new Command("links")
    .description("List HTTP(S) links from a web page")
    .argument("<url>", "HTTP or HTTPS URL")
    .option("--limit <count>", "Maximum links to return (1-100)", Number)
    .option("--render <renderer>", "Rendering mode: http (default) or browser")
    .option(
      "--wait <milliseconds>",
      "Required post-load wait for --render browser (0-30000)",
      Number,
    )
    .option("--json", "Output the structured result as JSON")
    .action(
      async (
        url: string,
        options: {
          limit?: number;
          render?: "http" | "browser";
          wait?: number;
          json?: boolean;
        },
      ) => {
        const result = await dependencies.operations.links({
          url,
          limit: options.limit,
          ...(options.render !== undefined ? { render: options.render } : {}),
          ...(options.wait !== undefined ? { waitMs: options.wait } : {}),
        });
        if (options.json) {
          writeOut(JSON.stringify(result) + "\n");
          return;
        }
        writeOut(formatLinks(result));
      },
    );
}

function formatLinks(result: LinksResult): string {
  if (result.links.length === 0) return "No HTTP(S) links found.\n";
  let output = `Found ${result.links.length} link${result.links.length === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}:\n\n`;
  for (const [index, link] of result.links.entries()) {
    output += `${index + 1}. ${link.text || "(no text)"}\n`;
    output += `   URL: ${link.url}\n\n`;
  }
  return output;
}
