import type { Context } from "@deepseek-ai/cordis";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

import {
  PROVIDERS,
  SETTINGS_NAMESPACE,
  type GuionSettings,
} from "./contract.js";
import { createGuionSearchProvider } from "./provider.js";
import { registerWebTools } from "./tools.js";

export const name = "guionai-dsh-web";
export const inject = ["web", "credentials", "settings", "tools"] as const;

export const SettingsSchema = z.object({
  provider: z.union(PROVIDERS).default("exa"),
});

export function apply(ctx: Context): void {
  const settings = ctx.settings.register(
    settingsNamespace(SETTINGS_NAMESPACE),
    SettingsSchema,
    {
      base: { provider: "exa" },
      applies: "live",
    },
  );
  ctx.web.registerSearchProvider(
    createGuionSearchProvider({
      getProvider: () => (settings.get() as GuionSettings).provider,
      credentials: ctx.credentials,
    }),
  );
  registerWebTools(ctx, { credentials: ctx.credentials });
}
