import { createWebOperations } from "@guionai/web-core";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

import {
  DEFAULT_KEPOS_BRIDGE_ENDPOINT,
  PROVIDERS,
  SETTINGS_NAMESPACE,
  type GuionSettings,
  validateKeposBridgeEndpoint,
} from "./contract.js";
import { createGuionSearchProvider } from "./provider.js";
import { registerKeposTools, registerWebTools } from "./tools.js";

export const name = "guionai-dsh-web";
export const inject = ["web", "credentials", "settings", "tools"] as const;

const keposBridgeEndpointSchema = z
  .string()
  .pattern(/^https?:\/\/[^\/?#@\s]+(?:\/[^?#\s]*)?$/i)
  .default(DEFAULT_KEPOS_BRIDGE_ENDPOINT);

export const SettingsSchema = z.object({
  provider: z.union(PROVIDERS).default("exa"),
  keposBridgeEndpoint: keposBridgeEndpointSchema,
});

export function apply(ctx: Context): void {
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, SettingsSchema, {
    base: {
      provider: "exa",
      keposBridgeEndpoint: DEFAULT_KEPOS_BRIDGE_ENDPOINT,
    },
    applies: "live",
    validate(value) {
      validateKeposBridgeEndpoint(value.keposBridgeEndpoint);
    },
  });
  const operations = createWebOperations();
  ctx.web.registerSearchProvider(
    createGuionSearchProvider({
      getProvider: () => (settings.get() as GuionSettings).provider,
      getKeposBridgeEndpoint: () =>
        (settings.get() as GuionSettings).keposBridgeEndpoint,
      credentials: ctx.credentials,
      operations,
    }),
  );
  const toolDependencies = {
    credentials: ctx.credentials,
    operations,
    getKeposBridgeEndpoint: () =>
      (settings.get() as GuionSettings).keposBridgeEndpoint,
  };

  const install = () => {
    const directDisposers = registerWebTools(ctx, toolDependencies);
    let keposDisposers: Array<() => void> = [];
    let keposActive = false;
    const disposeKepos = () => {
      if (!keposActive) return;
      keposActive = false;
      for (const dispose of keposDisposers.splice(0).reverse()) dispose();
    };
    const registerKepos = () => {
      if (!keposActive) {
        keposDisposers = registerKeposTools(ctx, toolDependencies);
        keposActive = true;
      }
    };
    const currentProvider = () => (settings.get() as GuionSettings).provider;
    if (currentProvider() === "kepos-bridge") registerKepos();
    const watch = settings.watch(
      (next: GuionSettings, previous: GuionSettings) => {
        if (next.provider === previous.provider) return;
        if (next.provider === "kepos-bridge") registerKepos();
        else disposeKepos();
      },
    );
    return () => {
      watch();
      disposeKepos();
      for (const dispose of directDisposers.reverse()) dispose();
    };
  };

  ctx.effect(install, "guionai-dsh-web: provider tools");
}
