export const SETTINGS_NAMESPACE = "guionai-web" as const;
export const SEARCH_PROVIDER_ID = "guionai-web-search" as const;

export const DEFAULT_KEPOS_BRIDGE_ENDPOINT =
  "http://127.0.0.1:8787/codex/web-search" as const;

export const PROVIDERS = ["exa", "brave", "kepos-bridge"] as const;
export type SearchProviderName = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<SearchProviderName, string> = {
  exa: "Exa",
  brave: "Brave",
  "kepos-bridge": "Kepos Bridge",
};

/** DSH-owned references; these names never identify a value in settings. */
export const EXA_CREDENTIAL_REF = "GUIONAI_DSH_WEB_EXA_API_KEY" as const;
export const BRAVE_CREDENTIAL_REF = "GUIONAI_DSH_WEB_BRAVE_API_KEY" as const;
export const CONTEXT7_CREDENTIAL_REF =
  "GUIONAI_DSH_WEB_CONTEXT7_API_KEY" as const;
export const CREDENTIAL_REFS = [
  EXA_CREDENTIAL_REF,
  BRAVE_CREDENTIAL_REF,
  CONTEXT7_CREDENTIAL_REF,
] as const;

export interface GuionSettings {
  provider: SearchProviderName;
  keposBridgeEndpoint: string;
}

export function isValidKeposBridgeEndpoint(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    !/^https?:\/\//i.test(value) ||
    value.includes("?") ||
    value.includes("#")
  )
    return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function validateKeposBridgeEndpoint(value: unknown): string {
  if (!isValidKeposBridgeEndpoint(value))
    throw new Error(
      "Kepos Bridge endpoint must be an absolute HTTP(S) URL without credentials, query, or fragment",
    );
  return value;
}

export function isSearchProvider(value: unknown): value is SearchProviderName {
  return (
    typeof value === "string" &&
    (PROVIDERS as readonly string[]).includes(value)
  );
}
