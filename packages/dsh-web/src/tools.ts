import {
  docsFetch,
  docsResolve,
  fetchWebPage,
  sgraphSearch,
  type Context7Credentials,
  type DocsFetchInput,
  type DocsFetchResult,
  type DocsResolveInput,
  type DocsResolveResult,
  type FetchInput,
  type FetchResult,
  type SGraphInput,
  type SGraphResult,
} from "@guionai/web-core";
import {
  credentialRef,
  type CredentialRef,
  type ResolvedCredential,
} from "@deepseek-ai/dsh-credentials";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";

import { CONTEXT7_CREDENTIAL_REF } from "./contract.js";
import { formatSize, truncateHead } from "./truncate-core.js";

const DEFAULT_TREE_THRESHOLD = 5000;

export interface WebToolDependencies {
  credentials: {
    resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
  };
  fetch?: (input: FetchInput, signal?: AbortSignal) => Promise<FetchResult>;
  docsResolve?: (input: DocsResolveInput) => Promise<DocsResolveResult>;
  docsFetch?: (input: DocsFetchInput) => Promise<DocsFetchResult>;
  sgraphSearch?: (input: SGraphInput) => Promise<SGraphResult>;
}

type DocsInput =
  | { action: "resolve"; query: string }
  | { action: "fetch"; library_id: string; topic?: string; tokens?: number };

const fetchParameters = {
  url: { type: "string", required: true, description: "HTTP or HTTPS URL to fetch" },
  tree: { type: "boolean", description: "Show the page heading tree" },
  section_id: { type: "string", description: "Optional heading section ID to return" },
  full: { type: "boolean", description: "Return full content without automatic tree mode" },
  tree_threshold: {
    type: "integer",
    default: DEFAULT_TREE_THRESHOLD,
    description: "Automatic tree threshold; defaults to 5000",
  },
} as const;

const docsParameters = {
  action: { type: "string", enum: ["resolve", "fetch"], required: true, description: "Documentation operation" },
  query: { type: "string", description: "Library name or package query" },
  library_id: { type: "string", description: "Context7 library ID returned by resolve" },
  topic: { type: "string", description: "Optional documentation topic" },
  tokens: { type: "integer", default: 0, description: "Optional token budget for fetch; zero uses the backend default" },
} as const;

const sgraphParameters = {
  query: { type: "string", required: true, description: "Sourcegraph search query" },
  count: { type: "integer", default: 10, description: "Optional result count; defaults to 10" },
  context: { type: "integer", default: 10, description: "Optional context lines; defaults to 10" },
  timeout: { type: "integer", default: 0, description: "Optional timeout in seconds; zero disables the timeout" },
} as const;

const fetchOutput = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", required: true },
      mode: { type: "string", enum: ["full", "tree", "section"], required: true },
      content: { type: "string", required: true },
    },
  } as const,
  render: (_args: unknown, value: FetchResult) => [{
    type: "text" as const,
    text: boundedToolText(value.content, "Use web_fetch with tree or section_id to navigate the document."),
  }],
};

const docsOutput = {
  schema: {
    oneOf: [
      {
        type: "object", additionalProperties: false,
        properties: {
          query: { type: "string", required: true },
          libraries: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
            id: { type: "string", required: true }, title: { type: "string", required: true },
            description: { type: "string" }, trust_score: { type: "number" }, total_snippets: { type: "integer" },
            versions: { type: "array", items: { type: "string" } },
          } } },
        },
      },
      {
        type: "object", additionalProperties: false,
        properties: { library_id: { type: "string", required: true }, topic: { type: "string" }, content: { type: "string", required: true } },
      },
    ],
  } as const,
  render: (_args: unknown, value: DocsResolveResult | DocsFetchResult) => [{
    type: "text" as const,
    text: "libraries" in value
      ? boundedToolText(formatDocsResolve(value), "Use web_docs action fetch with a library_id from the results.")
      : boundedToolText(value.content, "Refetch with a narrower topic or tokens budget for the remainder."),
  }],
};

const sgraphOutput = {
  schema: { type: "object", additionalProperties: false, properties: { content: { type: "string", required: true } } } as const,
  render: (_args: unknown, value: SGraphResult) => [{
    type: "text" as const,
    text: boundedToolText(value.content, "Use a narrower Sourcegraph query or lower count and context."),
  }],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(input: unknown, fields: readonly string[], toolName: string): void {
  if (!isRecord(input)) return;
  for (const field of Object.keys(input)) if (!fields.includes(field)) throw new Error(`${toolName} input does not accept field ${field}`);
}

function strictDefinition(definition: ToolDefinition): ToolDefinition {
  return { ...definition, parameters: { ...definition.parameters, additionalProperties: false } };
}

function requireString(input: unknown, field: string): string {
  if (!isRecord(input) || typeof input[field] !== "string" || input[field].length === 0) throw new Error(`${field} must be a non-empty string`);
  return input[field];
}

function normalizeDocs(input: unknown): DocsInput {
  if (!isRecord(input)) throw new Error("web_docs input must be an object");
  for (const field of Object.keys(input)) if (!["action", "query", "library_id", "topic", "tokens"].includes(field)) throw new Error(`web_docs input does not accept field ${field}`);
  if (input.action !== "resolve" && input.action !== "fetch") throw new Error('web_docs action must be "resolve" or "fetch"');
  if (input.action === "resolve") {
    if ("library_id" in input || "topic" in input || "tokens" in input) throw new Error('web_docs action "resolve" does not accept library_id, topic, or tokens');
    return { action: "resolve", query: requireString(input, "query") };
  }
  if ("query" in input) throw new Error('web_docs action "fetch" does not accept query');
  const library_id = requireString(input, "library_id");
  if (input.topic !== undefined && typeof input.topic !== "string") throw new Error("topic must be a string");
  if (input.tokens !== undefined && (!Number.isInteger(input.tokens) || typeof input.tokens !== "number")) throw new Error("tokens must be an integer");
  return { action: "fetch", library_id, topic: input.topic as string | undefined, tokens: input.tokens as number | undefined };
}

async function context7Credentials(dependencies: WebToolDependencies): Promise<Context7Credentials> {
  let resolved: ResolvedCredential | undefined;
  try {
    resolved = await dependencies.credentials.resolve(credentialRef(CONTEXT7_CREDENTIAL_REF));
  } catch {
    throw new Error("Context7 credential resolution failed");
  }
  return resolved === undefined ? {} : { context7ApiKey: resolved.value };
}

function boundedToolText(content: string, hint: string): string {
  const truncation = truncateHead(content);
  if (!truncation.truncated) return content;
  const guidance = hint.trim() === "" ? "" : ` ${hint.trim()}`;
  if (truncation.firstLineExceedsLimit) return `[First line is ${formatSize(truncation.totalBytes)}, exceeds ${formatSize(truncation.maxBytes)} limit.${guidance}]`;
  if (truncation.truncatedBy === "lines") return `${truncation.content}\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines} line limit).${guidance}]`;
  return `${truncation.content}\n\n[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes)} limit).${guidance}]`;
}

function formatDocsResolve(result: DocsResolveResult): string {
  if (result.libraries.length === 0) return `No libraries found for ${JSON.stringify(result.query)}`;
  return `Found ${result.libraries.length} libraries:\n${result.libraries.map((library) => `- ${library.id}: ${library.title}`).join("\n")}`;
}

function webFetchTool(dependencies: WebToolDependencies): ToolDefinition {
  const fetch = dependencies.fetch ?? fetchWebPage;
  return strictDefinition(defineTool({
    name: "web_fetch", description: "Fetch and read an HTTP or HTTPS web page as Markdown with heading-tree and section navigation.",
    parameters: fetchParameters, output: fetchOutput, isConcurrencySafe: () => true,
    async execute(args, exec) {
      rejectUnknownFields(args, Object.keys(fetchParameters), "web_fetch");
      return fetch({ url: requireString(args, "url"), tree: args.tree, section_id: args.section_id, full: args.full, tree_threshold: args.tree_threshold }, exec.signal);
    },
  }));
}

function webDocsTool(dependencies: WebToolDependencies): ToolDefinition {
  const resolve = dependencies.docsResolve ?? docsResolve;
  const fetch = dependencies.docsFetch ?? docsFetch;
  return strictDefinition(defineTool({
    name: "web_docs", description: "Resolve a library and fetch its documentation through Context7. Use action resolve with query, then action fetch with library_id.",
    parameters: docsParameters, output: docsOutput, isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = normalizeDocs(args);
      const credentials = await context7Credentials(dependencies);
      try {
        return input.action === "resolve"
          ? await resolve({ query: input.query, credentials, signal: exec.signal })
          : await fetch({ ...input, credentials, signal: exec.signal });
      } catch (error) {
        if (error instanceof Error && error.message === "Operation aborted") throw error;
        throw new Error(`web docs ${input.action} failed`);
      }
    },
  }));
}

function webSgraphTool(dependencies: WebToolDependencies): ToolDefinition {
  const operation = dependencies.sgraphSearch ?? sgraphSearch;
  return strictDefinition(defineTool({
    name: "web_sgraph", description: "Search public source code through Sourcegraph.",
    parameters: sgraphParameters, output: sgraphOutput, isConcurrencySafe: () => true,
    async execute(args, exec) {
      rejectUnknownFields(args, Object.keys(sgraphParameters), "web_sgraph");
      return operation({ query: requireString(args, "query"), count: args.count, context: args.context, timeout: args.timeout, signal: exec.signal });
    },
  }));
}

export function createWebToolDefinitions(dependencies: WebToolDependencies): readonly [ToolDefinition, ToolDefinition, ToolDefinition] {
  return [webFetchTool(dependencies), webDocsTool(dependencies), webSgraphTool(dependencies)];
}

export function registerWebTools(ctx: Context, dependencies: WebToolDependencies): void {
  for (const definition of createWebToolDefinitions(dependencies)) ctx.tools.register(definition);
}
