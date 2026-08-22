import {
  formatSearchResults,
  search,
  type SearchCredentials,
  type SearchInput,
  type SearchResponse,
} from "@guionai/web-core";

export { formatSearchResults, search } from "@guionai/web-core";
export type { SearchCredentials, SearchInput, SearchResponse } from "@guionai/web-core";

export type SearchService = {
  search(input: SearchInput): Promise<SearchResponse>;
};

export function createSearchService(): SearchService {
  return { search };
}

export function credentialsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SearchCredentials {
  return {
    exaApiKey: environment.EXA_API_KEY,
    braveApiKey: environment.BRAVE_API_KEY,
  };
}
