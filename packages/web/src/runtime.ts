import type { WebCredentials } from "@guionai/web-core";

export type { WebCredentials } from "@guionai/web-core";

export function credentialsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): WebCredentials {
  return {
    exaApiKey: environment.EXA_API_KEY,
    braveApiKey: environment.BRAVE_API_KEY,
    ...(Object.hasOwn(environment, "CONTEXT7_API_KEY")
      ? { context7ApiKey: environment.CONTEXT7_API_KEY }
      : {}),
  };
}
