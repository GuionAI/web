import {
  fetchWebPage,
  formatSearchResults,
  search,
  type FetchInput,
  type FetchResult,
  type SearchCredentials,
  type SearchInput,
  type SearchResponse,
} from "@guionai/web-core";

export {
  fetchWebPage,
  formatSearchResults,
  renderMarkdown,
  search,
  truncateContent,
} from "@guionai/web-core";
export type {
  FetchCache,
  FetchInput,
  FetchOptions,
  FetchResult,
  MarkdownResult,
  SearchCredentials,
  SearchInput,
  SearchResponse,
} from "@guionai/web-core";

export type WebService = {
  search(input: SearchInput): Promise<SearchResponse>;
  fetch(input: FetchInput, signal?: AbortSignal): Promise<FetchResult>;
};

export function createWebService(): WebService {
  return { search, fetch: fetchWebPage };
}

export function credentialsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SearchCredentials {
  return {
    exaApiKey: environment.EXA_API_KEY,
    braveApiKey: environment.BRAVE_API_KEY,
  };
}
