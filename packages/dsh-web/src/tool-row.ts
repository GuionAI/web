import { createElement, useState } from "react";
import {
  DisclosureRow,
  IconBrowseOutline16,
  IconGlobeOutline14,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import css from "./tool-row.module.dshcss";

const TITLES = {
  web_search: "Search the web",
  web_fetch: "Fetch page",
  web_links: "Find links",
  web_docs: "Documentation",
  web_source_search: "Search source",
  web_weather: "Weather",
  web_sports: "Sports",
  web_finance: "Finance",
  web_time: "Time",
} as const;

export const RESEARCH_TOOL_NAMES = Object.keys(TITLES) as ResearchToolName[];
type ResearchToolName = keyof typeof TITLES;

/**
 * Non-default request choices shown beside the collapsed research summary.
 * @param name - Guion research tool name.
 * @param args - Parsed model-supplied arguments, possibly incomplete while streaming.
 * @returns Compact labels for explicit choices that differ from defaults.
 */
export function researchParameters(
  name: string,
  args: Record<string, unknown>,
): string[] {
  const tags: string[] = [];
  const add = (key: string, label: string, fallback?: unknown) => {
    const value = args[key];
    if (
      (typeof value === "string" || typeof value === "number") &&
      value !== "" &&
      value !== fallback
    ) {
      tags.push(`${label}: ${value}`);
    }
  };
  if (name === "web_fetch" || name === "web_links") {
    if (args.render === "browser") {
      tags.push("browser");
      if (typeof args.waitMs === "number")
        tags.push(`wait: ${args.waitMs / 1000} s`);
    }
    if (name === "web_fetch") {
      add("mode", "mode", "auto");
      add("section_id", "section");
    } else add("limit", "limit", 100);
  } else if (name === "web_docs") {
    add("topic", "topic");
    add("tokens", "tokens", 0);
  } else if (name === "web_source_search") {
    add("count", "count", 10);
    add("context", "context", 10);
    add("timeout", "timeout", 0);
  } else if (name === "web_weather") {
    add("start", "from");
    add("duration", "days");
  } else if (name === "web_sports") {
    add("opponent", "opponent");
    add("date_from", "from");
    add("date_to", "to");
    add("num_games", "games");
    add("locale", "locale");
  } else if (name === "web_finance") {
    add("type", "type");
    add("market", "market");
  }
  return tags;
}

function summary(name: string, args: Record<string, unknown>): string {
  if (name === "web_search")
    return Array.isArray(args.queries)
      ? args.queries
          .filter((query): query is string => typeof query === "string")
          .join(", ")
      : "";
  if (name === "web_docs")
    return text(args.action === "resolve" ? args.query : args.library_id);
  if (name === "web_source_search") return text(args.query);
  if (name === "web_weather") return text(args.location);
  if (name === "web_sports")
    return [args.league, args.fn, args.team]
      .map(text)
      .filter(Boolean)
      .join(" · ");
  if (name === "web_finance") return text(args.ticker);
  if (name === "web_time") return text(args.utc_offset);
  return text(args.url);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    // Streamed arguments may be incomplete before the call is admitted.
    return {};
  }
}

/**
 * Render persisted research inputs and results with native disclosure behavior.
 * @param props - Current tool block and optional native inspection action.
 * @returns A collapsed research row with scrollable request and result details.
 */
export function ResearchToolRow({
  toolName,
  block,
  inspect,
}: ToolCallViewProps) {
  const [open, setOpen] = useState(false);
  const settled = "kind" in block && block.kind === "tool-result";
  const failed = settled && block.isError;
  const raw = (settled ? block.call?.argsRaw : block.argsRaw) ?? "";
  const args = parseArguments(raw);
  const output = settled
    ? block.content
        .flatMap((part: unknown) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("\n")
    : "";
  const error =
    failed && block.error ? `${block.error.name}: ${block.error.code}` : "";
  const title =
    toolName === "web_docs"
      ? args.action === "resolve"
        ? "Find documentation"
        : "Fetch documentation"
      : (TITLES[toolName as ResearchToolName] ?? toolName);
  const target = summary(toolName, args);
  const state = !settled ? "Working…" : failed ? "Failed" : "Complete";
  const tags = researchParameters(toolName, args);
  return createElement(
    DisclosureRow,
    {
      title,
      icon:
        !settled || failed
          ? createElement(StateDot, { state: failed ? "error" : "ongoing" })
          : createElement(
              toolName === "web_fetch"
                ? IconBrowseOutline16
                : IconGlobeOutline14,
              { size: 14 },
            ),
      open,
      expandable: true,
      expandOnRowClick: true,
      keepContentWhenOpen: true,
      onToggle: () => setOpen((value) => !value),
      className: css.root,
      rowClassName: css.row,
      collapsedContent: createElement(
        "span",
        { className: css.summary },
        createElement("span", { className: css.target, title: target }, target),
        createElement(
          "span",
          { className: css.tags },
          ...tags.map((tag) =>
            createElement(
              "span",
              { key: tag, className: css.tag, title: tag },
              tag,
            ),
          ),
        ),
        createElement(
          "span",
          {
            className: settled && !failed ? css.srOnly : css.state,
            role: "status",
            "data-error": failed || undefined,
          },
          state,
        ),
      ),
    },
    createElement(
      "div",
      { className: css.details },
      createElement(
        "div",
        { className: css.io },
        createElement(
          "div",
          {
            className: css.input,
            role: "region",
            "aria-label": "Research input",
            tabIndex: 0,
          },
          createElement("span", { className: css.label }, "IN"),
          createElement(
            "pre",
            { className: css.text },
            Object.keys(args).length
              ? JSON.stringify(args, null, 2)
              : raw || "Waiting for arguments…",
          ),
        ),
        createElement(
          "div",
          {
            className: css.output,
            role: "region",
            "aria-label": "Research output",
            tabIndex: 0,
          },
          createElement("span", { className: css.label }, "OUT"),
          createElement(
            "pre",
            { className: css.text, "data-error": failed || undefined },
            [error, output].filter(Boolean).join("\n") ||
              (!settled
                ? "Working…"
                : failed
                  ? "The request failed."
                  : "No output."),
          ),
        ),
      ),
      inspect
        ? createElement(
            "button",
            { type: "button", className: css.inspect, onClick: inspect },
            "Inspect",
          )
        : null,
    ),
  );
}
