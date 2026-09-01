import { describe, expect, it } from "vitest";

import {
  BRAVE_CREDENTIAL_REF,
  CONTEXT7_CREDENTIAL_REF,
  EXA_CREDENTIAL_REF,
  SETTINGS_NAMESPACE,
} from "../src/contract.js";
import {
  apply,
  decodeSettings,
  describeCredentialStatus,
  fetchDetails,
  persistProviderSelection,
  removeCredential,
  writeCredential,
} from "../src/client.js";

function fakeApi(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; payload: unknown }> = [];
  return {
    calls,
    credentials: {
      describe: async (refs: string[]) => ({
        ok: true,
        value: Object.fromEntries(
          refs.map((ref) => [
            ref,
            {
              configured: ref === EXA_CREDENTIAL_REF,
              source: "file",
              writable: true,
            },
          ]),
        ),
      }),
      set: async (ref: string, value: string) => {
        const payload = { ref, value };
        calls.push({ method: "set", payload });
        return overrides.set ?? { ok: true, value: undefined };
      },
      unset: async (ref: string) => {
        const payload = { ref };
        calls.push({ method: "unset", payload });
        return overrides.unset ?? { ok: true, value: undefined };
      },
    },
  } as any;
}

describe("DSH settings client credential surface", () => {
  it("labels the fetch backend, wait, and retrieval mode from its request", () => {
    expect(
      fetchDetails({
        render: "agent-browser",
        waitMs: 2_000,
        section_id: "installation",
      }),
    ).toEqual([
      { label: "Backend", value: "Browser rendered" },
      { label: "Wait", value: "2 s" },
      { label: "Result", value: "Section: installation" },
    ]);
    expect(fetchDetails({ tree: true })).toEqual([
      { label: "Backend", value: "Direct fetch" },
      { label: "Result", value: "Heading tree" },
    ]);
    expect(fetchDetails({ full: true })).toEqual([
      { label: "Backend", value: "Direct fetch" },
      { label: "Result", value: "Full document" },
    ]);
  });

  it("shadows the host fetch view and registers dedicated views for links and docs", () => {
    const registrations: Array<{ key: string; priority?: number }> = [
      { key: "web_fetch", priority: 0 },
    ];
    const ctx = {
      effect: () => undefined,
      remote: { credentials: {}, $on: () => () => undefined },
      settingsScope: { bind: () => ({}) },
      slots: {
        inject: (_name: string, callback: () => unknown) => {
          const value = callback();
          if (
            value !== null &&
            typeof value === "object" &&
            Symbol.iterator in value
          )
            for (const _registration of value as Iterable<unknown>) {
              // Exhaust the generator so every keyed registration is observed.
            }
        },
        register: (spec: { key: string; priority?: number }) => {
          if (
            registrations.some(
              (registration) =>
                registration.key === spec.key &&
                (registration.priority ?? 0) === (spec.priority ?? 0),
            )
          ) {
            throw new Error(`duplicate keyed slot entry: ${spec.key}`);
          }
          registrations.push(spec);
          return spec;
        },
      },
    };
    apply(ctx as any);
    expect(
      registrations.map(({ key, priority }) => ({ key, priority })),
    ).toEqual([
      { key: "web_fetch", priority: 0 },
      { key: SETTINGS_NAMESPACE },
      { key: "web_fetch", priority: -1 },
      { key: "web_links" },
      { key: "web_docs" },
    ]);
  });

  it("persists only the selected provider and drops unknown/secret settings fields", async () => {
    const calls: Array<{ field: string; value: unknown }> = [];
    await persistProviderSelection(
      { set: async (field, value) => void calls.push({ field, value }) },
      "exa",
    );
    expect(calls).toEqual([{ field: "provider", value: "exa" }]);
    expect(
      decodeSettings({ provider: "brave", apiKey: "secret-value" }),
    ).toEqual({
      provider: "brave",
    });
    expect(decodeSettings({ apiKey: "secret-value" })).toEqual({});
    expect(SETTINGS_NAMESPACE).toBe("guionai-web");
  });

  it("returns only credential metadata and keeps refs package-namespaced", async () => {
    const fixture = fakeApi();
    const status = await describeCredentialStatus(fixture.credentials, [
      EXA_CREDENTIAL_REF,
      BRAVE_CREDENTIAL_REF,
      CONTEXT7_CREDENTIAL_REF,
    ]);
    expect(status).toEqual({
      [EXA_CREDENTIAL_REF]: {
        configured: true,
        source: "file",
        writable: true,
      },
      [BRAVE_CREDENTIAL_REF]: {
        configured: false,
        source: "file",
        writable: true,
      },
      [CONTEXT7_CREDENTIAL_REF]: {
        configured: false,
        source: "file",
        writable: true,
      },
    });
    expect(JSON.stringify(status)).not.toContain("secret-value");
  });

  it("writes and removes secrets through credentials only, with blank drafts as no-ops", async () => {
    const fixture = fakeApi();
    expect(
      await writeCredential(fixture.credentials, EXA_CREDENTIAL_REF, ""),
    ).toBe(false);
    expect(fixture.calls).toEqual([]);
    expect(
      await writeCredential(
        fixture.credentials,
        EXA_CREDENTIAL_REF,
        "secret-value",
      ),
    ).toBe(true);
    await removeCredential(fixture.credentials, EXA_CREDENTIAL_REF);
    expect(fixture.calls).toEqual([
      {
        method: "set",
        payload: { ref: EXA_CREDENTIAL_REF, value: "secret-value" },
      },
      { method: "unset", payload: { ref: EXA_CREDENTIAL_REF } },
    ]);
    expect(JSON.stringify(fixture.calls)).toContain("secret-value");
  });

  it("maps rejected credential writes to safe UI errors", async () => {
    const fixture = fakeApi({
      set: {
        ok: false,
        error: { message: "secret-value rejected" },
      },
    });
    await expect(
      writeCredential(fixture.credentials, EXA_CREDENTIAL_REF, "secret-value"),
    ).rejects.toThrow("credential write rejected");
    await expect(
      writeCredential(fixture.credentials, EXA_CREDENTIAL_REF, "secret-value"),
    ).rejects.not.toThrow("secret-value");
  });
});
