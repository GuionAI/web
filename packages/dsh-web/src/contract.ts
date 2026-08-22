export const SETTINGS_NAMESPACE = "guionai-web" as const;
export const SEARCH_PROVIDER_ID = "guionai-web-search" as const;

export const PROVIDERS = ["exa", "brave"] as const;
export type SearchProviderName = (typeof PROVIDERS)[number];

/** DSH-owned references; these names never identify a value in settings. */
export const EXA_CREDENTIAL_REF = "GUIONAI_DSH_WEB_EXA_API_KEY" as const;
export const BRAVE_CREDENTIAL_REF = "GUIONAI_DSH_WEB_BRAVE_API_KEY" as const;
export const CONTEXT7_CREDENTIAL_REF = "GUIONAI_DSH_WEB_CONTEXT7_API_KEY" as const;
export const CREDENTIAL_REFS = [
  EXA_CREDENTIAL_REF,
  BRAVE_CREDENTIAL_REF,
  CONTEXT7_CREDENTIAL_REF,
] as const;

export interface GuionSettings {
  provider: SearchProviderName;
}

export function isSearchProvider(value: unknown): value is SearchProviderName {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}
