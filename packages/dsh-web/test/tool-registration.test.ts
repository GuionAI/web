import { SlotCore } from "@deepseek-ai/dsh-client-ui-slots";
import { describe, expect, it } from "vitest";
import { apply } from "../src/client.js";

describe("research views alongside native DSH views", () => {
  it.each(["native-first", "guion-first"])(
    "registers all Guion views with %s loading",
    (order) => {
      const core = new SlotCore();
      const empty = () => null;
      core.register(
        {
          name: "root",
          children: {
            "tool.call.toolview": { kind: "keyed", scope: "session" },
            "settings.plugin.item": { kind: "keyed", scope: "root" },
          },
        } as never,
        empty,
      );
      const native = () => {
        for (const key of ["web_search", "web_fetch"]) {
          core.register(
            {
              name: "tool.call.toolview",
              key,
              registrant: "web-toolview",
            } as never,
            empty,
          );
        }
      };
      const guion = () =>
        apply({
          effect: () => () => undefined,
          remote: {},
          settingsScope: { bind: () => ({}) },
          slots: {
            inject: (_name: string, callback: () => unknown) => {
              const effect = callback();
              if (
                effect &&
                typeof effect === "object" &&
                Symbol.iterator in effect
              ) {
                for (const _ of effect as Iterable<unknown>) {
                  /* Run every registration effect. */
                }
              }
            },
            register: (
              options: { name: string; key: string; priority?: number },
              component: Parameters<SlotCore["register"]>[1],
            ) =>
              core.register(
                { ...options, registrant: "guionai-dsh-web" } as never,
                component,
              ),
          },
        } as never);
      if (order === "native-first") {
        native();
        guion();
      } else {
        guion();
        native();
      }
      const entries = core.entries("tool.call.toolview");
      for (const key of [
        "web_search",
        "web_fetch",
        "web_links",
        "web_docs",
        "web_source_search",
        "web_weather",
        "web_sports",
        "web_finance",
        "web_time",
      ]) {
        const selected = entries.find((entry) => entry.options.key === key);
        expect(selected?.registrant).toBe("guionai-dsh-web");
      }
      expect(
        entries.filter((entry) => entry.registrant === "web-toolview"),
      ).toHaveLength(2);
    },
  );
});
