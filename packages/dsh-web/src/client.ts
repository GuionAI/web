import { createElement, useEffect, useState } from "react";
import type {
  ConnectionHandle,
  IApiClient,
} from "@deepseek-ai/dsh-client-connection/client";
import type {
  ClientContext,
  SettingsScope,
  SettingsScopeSpec,
} from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import cssText from "./client.css";

import {
  BRAVE_CREDENTIAL_REF,
  CREDENTIAL_REFS,
  EXA_CREDENTIAL_REF,
  PROVIDERS,
  SETTINGS_NAMESPACE,
  isSearchProvider,
  type GuionSettings,
  type SearchProviderName,
} from "./contract.js";

export const inject = [
  "connection",
  "remote",
  "settingsScope",
  "slots",
] as const;

type CredentialApi = Pick<IApiClient, "credentials">;
type RemoteApi = {
  $on(
    event: "credentials/updated",
    listener: (ref: string) => void,
  ): () => void;
};
export interface CredentialStatus {
  configured: boolean;
  source?: string;
  writable: boolean;
}

type ClientSettings = Partial<GuionSettings>;
export type GuionSettingsScope = SettingsScope<ClientSettings>;
export type GuionSettingsScopeSpec = SettingsScopeSpec<ClientSettings>;

export function decodeSettings(value: unknown): ClientSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const provider = (value as { provider?: unknown }).provider;
  return isSearchProvider(provider) ? { provider } : {};
}

export async function persistProviderSelection(
  scope: Pick<SettingsScope<ClientSettings>, "set">,
  provider: SearchProviderName,
): Promise<void> {
  await scope.set("provider", provider);
}

export async function describeCredentialStatus(
  api: CredentialApi,
  refs: readonly string[],
): Promise<Record<string, CredentialStatus>> {
  const response = await api.credentials.describe({ refs: [...refs] });
  if (!response.result.ok) throw new Error("credential status unavailable");
  const views = response.result.value.credentials;
  return Object.fromEntries(
    refs.map((ref) => {
      const view = views[ref];
      return [
        ref,
        {
          configured: view?.configured === true,
          ...(typeof view?.source === "string" && view.source.length > 0
            ? { source: view.source }
            : {}),
          writable: view?.writable === true,
        },
      ];
    }),
  );
}

export async function writeCredential(
  api: CredentialApi,
  ref: string,
  draft: string,
): Promise<boolean> {
  if (draft.trim() === "") return false;
  const response = await api.credentials.set({ ref, value: draft });
  if (!response.result.ok) throw new Error("credential write rejected");
  return true;
}

export async function removeCredential(
  api: CredentialApi,
  ref: string,
): Promise<void> {
  const response = await api.credentials.unset({ ref });
  if (!response.result.ok) throw new Error("credential removal rejected");
}

function SettingsCard({
  scope,
  api,
  remote,
}: {
  scope: GuionSettingsScope;
  api: CredentialApi;
  remote: RemoteApi;
}) {
  const [snapshot, setSnapshot] = useState(scope.getSnapshot());
  const [status, setStatus] = useState<Record<string, CredentialStatus>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(
    () => scope.subscribe(() => setSnapshot(scope.getSnapshot())),
    [scope],
  );
  useEffect(
    () =>
      remote.$on("credentials/updated", (ref) => {
        if ((CREDENTIAL_REFS as readonly string[]).includes(ref)) {
          setCredentialRevision((revision) => revision + 1);
        }
      }),
    [remote],
  );
  useEffect(() => {
    let active = true;
    void describeCredentialStatus(api, CREDENTIAL_REFS)
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setError("Credential status is unavailable.");
      });
    return () => {
      active = false;
    };
  }, [api, credentialRevision]);

  const provider = isSearchProvider(snapshot.value?.provider)
    ? snapshot.value.provider
    : "exa";
  const saveProvider = async (next: SearchProviderName) => {
    setError(undefined);
    try {
      await persistProviderSelection(scope, next);
    } catch {
      setError("Provider selection could not be saved.");
    }
  };
  const saveCredential = async (ref: string) => {
    setError(undefined);
    try {
      const wrote = await writeCredential(api, ref, drafts[ref] ?? "");
      if (wrote) {
        setDrafts((current) => ({ ...current, [ref]: "" }));
        setCredentialRevision((revision) => revision + 1);
      }
    } catch {
      setError("Credential could not be saved.");
    }
  };
  const clearCredential = async (ref: string) => {
    setError(undefined);
    try {
      await removeCredential(api, ref);
      setCredentialRevision((revision) => revision + 1);
    } catch {
      setError("Credential could not be removed.");
    }
  };

  return createElement(
    "section",
    {
      className: "guionai-web__settings",
      "aria-labelledby": "guionai-web-settings-title",
    },
    createElement(
      "h2",
      {
        id: "guionai-web-settings-title",
        className: "guionai-web__title",
      },
      "Guion Web",
    ),
    createElement(
      "p",
      { className: "guionai-web__copy" },
      "Choose the search provider explicitly. Both providers require an API key.",
    ),
    createElement(
      "label",
      { htmlFor: "guionai-web-provider", className: "guionai-web__label" },
      "Search provider",
      createElement(
        "select",
        {
          id: "guionai-web-provider",
          className: "guionai-web__select",
          value: provider,
          onChange: (event: { target: { value: string } }) => {
            if (isSearchProvider(event.target.value))
              void saveProvider(event.target.value);
          },
        },
        ...PROVIDERS.map((value) =>
          createElement("option", { key: value, value }, value),
        ),
      ),
    ),
    ...CREDENTIAL_REFS.map((ref) => {
      const label =
        ref === EXA_CREDENTIAL_REF
          ? "Exa API key"
          : ref === BRAVE_CREDENTIAL_REF
            ? "Brave API key"
            : "Context7 API key";
      const current = status[ref] ?? { configured: false, writable: false };
      return createElement(
        "fieldset",
        { key: ref, className: "guionai-web__credential" },
        createElement("legend", { className: "guionai-web__legend" }, label),
        createElement(
          "label",
          {
            htmlFor: `guionai-web-${ref}`,
            className: "guionai-web__label",
          },
          "Write a new key",
          createElement("input", {
            id: `guionai-web-${ref}`,
            type: "password",
            autoComplete: "new-password",
            className: "guionai-web__input",
            value: drafts[ref] ?? "",
            disabled: !current.writable,
            onChange: (event: { target: { value: string } }) =>
              setDrafts((draft) => ({ ...draft, [ref]: event.target.value })),
          }),
        ),
        createElement(
          "p",
          { role: "status", className: "guionai-web__status" },
          `Status: ${current.configured ? "configured" : "not configured"}; source: ${current.source ?? "none"}; writable: ${current.writable ? "yes" : "no"}.`,
        ),
        createElement(
          "div",
          { className: "guionai-web__actions" },
          createElement(
            "button",
            {
              type: "button",
              className: "guionai-web__button",
              disabled: !current.writable || (drafts[ref] ?? "").trim() === "",
              onClick: () => void saveCredential(ref),
            },
            "Save key",
          ),
          createElement(
            "button",
            {
              type: "button",
              className: "guionai-web__button",
              disabled: !current.writable || !current.configured,
              onClick: () => void clearCredential(ref),
            },
            "Remove key",
          ),
        ),
      );
    }),
    error
      ? createElement(
          "p",
          { role: "alert", className: "guionai-web__feedback" },
          error,
        )
      : null,
  );
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => installStyles(cssText), "guionai-web: styles");
  const connection = ctx.get("connection") as ConnectionHandle;
  const remote = ctx.get("remote") as RemoteApi;
  const scope = ctx.settingsScope.bind<ClientSettings>({
    namespace: SETTINGS_NAMESPACE,
    decode: decodeSettings,
  });

  ctx.slots.inject("settings.plugin.item", () =>
    ctx.slots.register(
      {
        name: "settings.plugin.item",
        key: SETTINGS_NAMESPACE,
        inject: () => ({}),
      } as never,
      (() =>
        createElement(SettingsCard, {
          scope,
          api: connection.api,
          remote,
        })) as never,
    ),
  );
  ctx.slots.inject("tool.call.toolview", function* () {
    for (const key of ["web_fetch", "web_links", "web_docs"]) {
      yield ctx.slots.register(
        {
          name: "tool.call.toolview",
          key,
          ...(key === "web_fetch" ? { priority: -1 } : {}),
          inject: () => ({}),
        } as never,
        ((props: ToolCallViewProps) =>
          createElement(WebResearchToolCard, props)) as never,
      );
    }
  });
}

function installStyles(css: string): () => void {
  const style = document.createElement("style");
  style.dataset.dshPlugin = "guionai-web";
  style.textContent = css;
  document.head.append(style);
  return () => style.remove();
}

type ResearchToolName = "web_fetch" | "web_links" | "web_docs";

function WebResearchToolCard({
  toolName,
  block,
}: ToolCallViewProps): ReturnType<typeof createElement> {
  const name = toolName as ResearchToolName;
  const args = toolArguments(block);
  const output = toolOutput(block);
  const running = !isToolResult(block);
  const error = isToolResult(block) && block.isError;
  const title =
    name === "web_fetch"
      ? "Fetch page"
      : name === "web_links"
        ? "Find links"
        : args.action === "resolve"
          ? "Find documentation"
          : "Fetch documentation";
  const summary = toolSummary(name, args);
  const details = name === "web_fetch" ? fetchDetails(args) : [];

  return createElement(
    "section",
    {
      className: "guionai-web__tool-card",
      "aria-label": title,
      "data-state": running ? "running" : error ? "error" : "success",
    },
    createElement(
      "div",
      { className: "guionai-web__tool-heading" },
      createElement("span", {
        className: "guionai-web__state-dot",
        "aria-hidden": true,
      }),
      createElement("strong", { className: "guionai-web__tool-title" }, title),
      createElement(
        "span",
        { className: "guionai-web__tool-state", role: "status" },
        running ? "Working…" : error ? "Failed" : "Complete",
      ),
    ),
    summary
      ? createElement("p", { className: "guionai-web__tool-summary" }, summary)
      : null,
    details.length > 0
      ? createElement(
          "dl",
          { className: "guionai-web__tool-details" },
          ...details.map((detail) =>
            createElement(
              "div",
              { key: detail.label },
              createElement("dt", null, detail.label),
              createElement("dd", null, detail.value),
            ),
          ),
        )
      : null,
    running
      ? null
      : error
        ? createElement(
            "p",
            { className: "guionai-web__tool-error", role: "alert" },
            block.error
              ? `${block.error.name}: ${block.error.code}`
              : "The request failed.",
          )
        : toolBody(name, args, output),
    !running && output
      ? createElement(
          "details",
          { className: "guionai-web__raw-output" },
          createElement("summary", null, "Show raw output"),
          createElement("pre", null, output),
        )
      : null,
  );
}

function toolBody(
  name: ResearchToolName,
  args: Record<string, unknown>,
  output: string,
): ReturnType<typeof createElement> | null {
  if (name === "web_links") {
    const links = linksFromOutput(output);
    const count = /^Found (\d+) links?/.exec(output)?.[1];
    return createElement(
      "div",
      { className: "guionai-web__tool-body" },
      createElement(
        "p",
        { className: "guionai-web__result-count" },
        count ? `${count} links found` : "Link scan complete",
      ),
      links.length > 0
        ? createElement(
            "ul",
            { className: "guionai-web__link-list" },
            ...links.slice(0, 5).map((link) =>
              createElement(
                "li",
                { key: link.url },
                createElement(
                  "a",
                  {
                    href: link.url,
                    target: "_blank",
                    rel: "noreferrer",
                    title: link.url,
                  },
                  link.text,
                ),
              ),
            ),
          )
        : null,
    );
  }
  if (name === "web_docs" && args.action === "resolve") {
    const libraries = librariesFromOutput(output);
    return createElement(
      "div",
      { className: "guionai-web__tool-body" },
      createElement(
        "p",
        { className: "guionai-web__result-count" },
        libraries.length > 0
          ? `${libraries.length} library matches`
          : "No libraries found",
      ),
      libraries.length > 0
        ? createElement(
            "ul",
            { className: "guionai-web__library-list" },
            ...libraries
              .slice(0, 5)
              .map((library) =>
                createElement(
                  "li",
                  { key: library.id },
                  createElement("code", null, library.id),
                  createElement("span", null, library.title),
                ),
              ),
          )
        : null,
    );
  }
  const url = typeof args.url === "string" ? args.url : undefined;
  return createElement(
    "div",
    { className: "guionai-web__tool-body" },
    url
      ? createElement(
          "a",
          {
            className: "guionai-web__source-link",
            href: url,
            target: "_blank",
            rel: "noreferrer",
          },
          "Open source",
        )
      : null,
    createElement("p", { className: "guionai-web__excerpt" }, excerpt(output)),
  );
}

function toolArguments(
  block: ToolCallViewProps["block"],
): Record<string, unknown> {
  const argsRaw = isToolResult(block) ? block.call?.argsRaw : block.argsRaw;
  if (!argsRaw) return {};
  try {
    const value: unknown = JSON.parse(argsRaw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toolOutput(block: ToolCallViewProps["block"]): string {
  if (!isToolResult(block)) return "";
  return block.content
    .map((content) =>
      content.type === "text" ? content.text : JSON.stringify(content),
    )
    .join("\n");
}

function toolSummary(
  name: ResearchToolName,
  args: Record<string, unknown>,
): string {
  if (name === "web_docs") {
    const identifier = args.action === "resolve" ? args.query : args.library_id;
    return typeof identifier === "string"
      ? identifier
      : "Documentation request";
  }
  if (typeof args.url !== "string")
    return name === "web_links" ? "Page links" : "Web page";
  try {
    const url = new URL(args.url);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return args.url;
  }
}

export function fetchDetails(
  args: Record<string, unknown>,
): Array<{ label: string; value: string }> {
  const browserRendered = args.render === "agent-browser";
  const details = [
    {
      label: "Backend",
      value: browserRendered ? "Browser rendered" : "Direct fetch",
    },
  ];
  if (browserRendered && typeof args.waitMs === "number") {
    details.push({ label: "Wait", value: formatWait(args.waitMs) });
  }
  details.push({ label: "Result", value: fetchResultMode(args) });
  return details;
}

function formatWait(waitMs: number): string {
  return waitMs >= 1_000 && waitMs % 1_000 === 0
    ? `${waitMs / 1_000} s`
    : `${waitMs} ms`;
}

function fetchResultMode(args: Record<string, unknown>): string {
  if (typeof args.section_id === "string" && args.section_id !== "")
    return `Section: ${args.section_id}`;
  if (args.tree === true) return "Heading tree";
  if (args.full === true) return "Full document";
  return "Adaptive document";
}

function excerpt(output: string): string {
  const compact = output.replace(/\s+/g, " ").trim();
  return compact.length <= 360 ? compact : `${compact.slice(0, 357)}…`;
}

function linksFromOutput(output: string): Array<{ text: string; url: string }> {
  return [...output.matchAll(/^\d+\. (.+)\n\s*URL: (https?:\/\/\S+)$/gm)].map(
    ([, text, url]) => ({ text: text || "(no text)", url: url! }),
  );
}

function librariesFromOutput(
  output: string,
): Array<{ id: string; title: string }> {
  return [...output.matchAll(/^- (.+?): (.+)$/gm)].map(([, id, title]) => ({
    id: id!,
    title: title!,
  }));
}

function isToolResult(
  block: ToolCallViewProps["block"],
): block is Extract<ToolCallViewProps["block"], { kind: "tool-result" }> {
  return "kind" in block && block.kind === "tool-result";
}
