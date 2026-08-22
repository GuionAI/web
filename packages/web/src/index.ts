import {
  docsFetch,
  docsResolve,
  fetchWebPage,
  formatSearchResults,
  search,
  type Context7Credentials,
  type DocsFetchInput,
  type DocsFetchResult,
  type DocsResolveInput,
  type DocsResolveResult,
  type FetchInput,
  type FetchResult,
  type SearchCredentials,
  type SearchInput,
  type SearchResponse,
} from "@guionai/web-core";

export {
  docsFetch,
  docsResolve,
  fetchWebPage,
  formatSearchResults,
  normalizeLibraryID,
  renderMarkdown,
  search,
  truncateContent,
} from "@guionai/web-core";
export type {
  Context7Credentials,
  DocsFetchInput,
  DocsFetchResult,
  DocsLibrary,
  DocsResolveInput,
  DocsResolveResult,
  FetchCache,
  FetchInput,
  FetchOptions,
  FetchResult,
  MarkdownResult,
  SearchCredentials,
  SearchInput,
  SearchResponse,
} from "@guionai/web-core";

export type WebCredentials = SearchCredentials & Context7Credentials;

export type WebService = {
  search(input: SearchInput): Promise<SearchResponse>;
  fetch(input: FetchInput, signal?: AbortSignal): Promise<FetchResult>;
  docsResolve(input: DocsResolveInput): Promise<DocsResolveResult>;
  docsFetch(input: DocsFetchInput): Promise<DocsFetchResult>;
};

export function createWebService(): WebService {
  return { search, fetch: fetchWebPage, docsResolve, docsFetch };
}

export function credentialsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): WebCredentials {
  return {
    exaApiKey: environment.EXA_API_KEY,
    braveApiKey: environment.BRAVE_API_KEY,
    ...(Object.hasOwn(environment, "CONTEXT7_API_KEY") ? { context7ApiKey: environment.CONTEXT7_API_KEY } : {}),
  };
}
