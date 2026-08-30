import { createElement, useEffect, useId, useState } from "react";
import { IconChevronDownOutline14 } from "@deepseek-ai/dsh-client-ui-primitives";
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
import styles from "./settings.module.dshcss";

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
  const [draftProvider, setDraftProvider] = useState<SearchProviderName>();
  const [removals, setRemovals] = useState<readonly string[]>([]);
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const cardId = useId();

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
  const selectedProvider = draftProvider ?? provider;
  const dirty =
    draftProvider !== undefined ||
    removals.length > 0 ||
    Object.values(drafts).some((value) => value.trim() !== "");
  const discard = () => {
    if (saving) return;
    setDraftProvider(undefined);
    setDrafts({});
    setRemovals([]);
    setError(undefined);
  };
  const save = async () => {
    if (!dirty || saving) return;
    setError(undefined);
    setSaving(true);
    try {
      if (draftProvider !== undefined)
        await persistProviderSelection(scope, draftProvider);
      for (const ref of CREDENTIAL_REFS) {
        if (removals.includes(ref)) await removeCredential(api, ref);
        else await writeCredential(api, ref, drafts[ref] ?? "");
      }
      setDraftProvider(undefined);
      setDrafts({});
      setRemovals([]);
      setCredentialRevision((revision) => revision + 1);
    } catch {
      setError("These settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return createElement(
    "li",
    {
      className: `${styles.card} ${open ? styles.open : ""}`,
      "data-settings-card": SETTINGS_NAMESPACE,
    },
    createElement(
      "button",
      {
        type: "button",
        className: styles.header,
        "aria-expanded": open,
        "aria-controls": `${cardId}-body`,
        onClick: () => setOpen((value) => !value),
      },
      createElement(
        "span",
        { className: styles.headText },
        createElement("span", { className: styles.name }, "Guion Web"),
        createElement(
          "span",
          { className: styles.description },
          "Search provider and API credentials.",
        ),
      ),
      dirty
        ? createElement("span", { className: styles.pending }, "Unsaved")
        : null,
      createElement(IconChevronDownOutline14, {
        className: `${styles.chevron} ${open ? styles.chevronOpen : ""}`,
      }),
    ),
    open
      ? createElement(
          "div",
          { className: styles.body, id: `${cardId}-body` },
          createElement(
            "div",
            { className: styles.field },
            createElement(
              "label",
              { className: styles.label, htmlFor: `${cardId}-provider` },
              "Search provider",
            ),
            createElement(
              "select",
              {
                className: styles.control,
                id: `${cardId}-provider`,
                value: selectedProvider,
                disabled: saving || !snapshot.writable,
                onChange: (event: { target: { value: string } }) => {
                  if (!isSearchProvider(event.target.value)) return;
                  setDraftProvider(
                    event.target.value === provider
                      ? undefined
                      : event.target.value,
                  );
                  setError(undefined);
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
            const current = status[ref] ?? {
              configured: false,
              writable: false,
            };
            const removing = removals.includes(ref);
            return createElement(
              "div",
              { className: styles.field, key: ref },
              createElement(
                "div",
                { className: styles.fieldHead },
                createElement(
                  "label",
                  { className: styles.label, htmlFor: `${cardId}-${ref}` },
                  label,
                ),
                createElement(
                  "span",
                  {
                    className:
                      current.configured && !removing
                        ? styles.badge
                        : styles.badgeMuted,
                  },
                  removing
                    ? "Will remove"
                    : current.configured
                      ? "Configured"
                      : "Not configured",
                ),
              ),
              createElement("input", {
                className: styles.control,
                id: `${cardId}-${ref}`,
                type: "password",
                autoComplete: "new-password",
                placeholder: current.configured
                  ? "Enter a replacement key"
                  : "Enter API key",
                value: drafts[ref] ?? "",
                disabled: saving || !current.writable || removing,
                onChange: (event: { target: { value: string } }) => {
                  setDrafts((draft) => ({
                    ...draft,
                    [ref]: event.target.value,
                  }));
                  setError(undefined);
                },
              }),
              current.writable && current.configured
                ? createElement(
                    "button",
                    {
                      className: styles.remove,
                      type: "button",
                      disabled: saving,
                      onClick: () => {
                        setRemovals((values) =>
                          values.includes(ref)
                            ? values.filter((value) => value !== ref)
                            : [...values, ref],
                        );
                        setDrafts((values) => ({ ...values, [ref]: "" }));
                        setError(undefined);
                      },
                    },
                    removing ? "Keep configured key" : "Remove configured key",
                  )
                : null,
            );
          }),
          createElement(
            "div",
            { className: styles.footer },
            error
              ? createElement(
                  "p",
                  { className: styles.error, role: "alert" },
                  error,
                )
              : null,
            createElement(
              "button",
              {
                className: styles.discard,
                type: "button",
                disabled: !dirty || saving,
                onClick: discard,
              },
              "Discard",
            ),
            createElement(
              "button",
              {
                className: styles.save,
                type: "button",
                disabled: !dirty || saving,
                onClick: () => void save(),
              },
              saving ? "Saving…" : "Save",
            ),
          ),
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
