import {
  createWebOperations,
  type SearchCredentials,
  type SearchResponse,
  type WebOperations,
} from "@guionai/web-core";
import {
  credentialRef,
  type CredentialRef,
  type ResolvedCredential,
} from "@deepseek-ai/dsh-credentials";
import type { WebSearchProvider, WebSearchResult } from "@deepseek-ai/dsh-web";

import {
  BRAVE_CREDENTIAL_REF,
  EXA_CREDENTIAL_REF,
  SEARCH_PROVIDER_ID,
  type SearchProviderName,
} from "./contract.js";

export interface SearchProviderDependencies {
  getProvider: () => SearchProviderName;
  credentials: {
    resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
  };
  operations?: WebOperations;
}

function credentialFor(provider: SearchProviderName): {
  ref: CredentialRef;
  field: keyof SearchCredentials;
} {
  switch (provider) {
    case "exa":
      return { ref: credentialRef(EXA_CREDENTIAL_REF), field: "exaApiKey" };
    case "brave":
      return { ref: credentialRef(BRAVE_CREDENTIAL_REF), field: "braveApiKey" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSearchResult(
  value: unknown,
  provider: SearchProviderName,
): WebSearchResult {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error(`${provider} search returned an invalid results array`);
  }

  const sources = value.results.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(
        `${provider} search returned an invalid result at index ${index}: source must be an object`,
      );
    }
    const link = raw.link;
    const title = raw.title;
    const snippet = raw.snippet;
    if (typeof link !== "string" || link.length === 0) {
      throw new Error(
        `${provider} search returned an invalid result at index ${index}: link must be a non-empty string`,
      );
    }
    if (typeof title !== "string") {
      throw new Error(
        `${provider} search returned an invalid result at index ${index}: title must be a string`,
      );
    }
    if (typeof snippet !== "string") {
      throw new Error(
        `${provider} search returned an invalid result at index ${index}: snippet must be a string`,
      );
    }
    return { url: link, title, snippet };
  });

  return { sources, truncated: false };
}

export function createGuionSearchProvider(
  dependencies: SearchProviderDependencies,
): WebSearchProvider {
  const operations = dependencies.operations ?? createWebOperations();
  return {
    id: SEARCH_PROVIDER_ID,
    // Selection is explicit in live DSH settings. Credentials are resolved for
    // each call and never escape into process-global state.
    available: () => true,
    async search(request, signal): Promise<WebSearchResult> {
      const provider = dependencies.getProvider();
      const credential = credentialFor(provider);
      let resolved: ResolvedCredential | undefined;
      try {
        resolved = await dependencies.credentials.resolve(credential.ref);
      } catch {
        throw new Error(`${provider} credential resolution failed`);
      }

      const credentials: SearchCredentials =
        resolved === undefined ? {} : { [credential.field]: resolved.value };
      let result: SearchResponse;
      try {
        result = await operations.search({
          query: request.query,
          provider,
          credentials,
          signal,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Operation aborted")
          throw error;
        throw new Error(`${provider} search failed`);
      }
      try {
        return validateSearchResult(result, provider);
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "invalid source";
        throw new Error(
          `${provider} search result validation failed: ${detail}`,
        );
      }
    },
  };
}
