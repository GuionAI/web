export const SETTINGS_NAMESPACE = "guionai-web" as const;

export {
  DEFAULT_KEPOS_BRIDGE_ENDPOINT,
  isValidKeposBridgeEndpoint,
  validateKeposBridgeEndpoint,
} from "@guionai/web-core/kepos-bridge";

export const PROVIDERS = ["exa", "brave", "deepseek", "kepos-bridge"] as const;
export type SearchProviderName = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<SearchProviderName, string> = {
  exa: "Exa",
  brave: "Brave",
  deepseek: "DeepSeek",
  "kepos-bridge": "Kepos Bridge",
};

/** DSH-owned references; these names never identify a value in settings. */
export const EXA_CREDENTIAL_REF = "GUIONAI_DSH_WEB_EXA_API_KEY" as const;
export const BRAVE_CREDENTIAL_REF = "GUIONAI_DSH_WEB_BRAVE_API_KEY" as const;
export const DEEPSEEK_CREDENTIAL_REF =
  "GUIONAI_DSH_WEB_DEEPSEEK_API_KEY" as const;
export const CONTEXT7_CREDENTIAL_REF =
  "GUIONAI_DSH_WEB_CONTEXT7_API_KEY" as const;
export const CREDENTIAL_REFS = [
  EXA_CREDENTIAL_REF,
  BRAVE_CREDENTIAL_REF,
  DEEPSEEK_CREDENTIAL_REF,
  CONTEXT7_CREDENTIAL_REF,
] as const;

export interface GuionSettings {
  provider: SearchProviderName;
  keposBridgeEndpoint: string;
}

export function isSearchProvider(value: unknown): value is SearchProviderName {
  return (
    typeof value === "string" &&
    (PROVIDERS as readonly string[]).includes(value)
  );
}
