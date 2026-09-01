import { describe, expect, it } from "vitest";

import {
  callKeposBridge,
  DEFAULT_KEPOS_BRIDGE_ENDPOINT,
  KEPOS_BRIDGE_MAX_REQUEST_BYTES,
  KEPOS_BRIDGE_MAX_RESPONSE_BYTES,
  isValidKeposBridgeEndpoint,
} from "../src/index.js";

describe("Kepos Bridge core client", () => {
  it("sends only the bounded stateless command envelope and keeps opaque results", async () => {
    let receivedURL = "";
    let receivedInit: RequestInit | undefined;
    const signal = new AbortController().signal;
    const result = await callKeposBridge({
      endpoint: DEFAULT_KEPOS_BRIDGE_ENDPOINT,
      commands: { search_query: [{ q: "bridge fixture" }] },
      signal,
      fetch: async (url, init) => {
        receivedURL = String(url);
        receivedInit = init;
        return Response.json({
          output: "citation prose",
          encrypted_output: "ignored",
          results: [
            { type: "text_result", url: "https://example.test", unknown: true },
            { type: "future_result", payload: { kept: true } },
          ],
          future_field: { ignored: true },
        });
      },
    });

    expect(receivedURL).toBe(DEFAULT_KEPOS_BRIDGE_ENDPOINT);
    expect(receivedInit?.method).toBe("POST");
    expect(new Headers(receivedInit?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(receivedInit?.body))).toEqual({
      commands: { search_query: [{ q: "bridge fixture" }] },
    });
    expect(result).toEqual({
      output: "citation prose",
      results: [
        { type: "text_result", url: "https://example.test", unknown: true },
        { type: "future_result", payload: { kept: true } },
      ],
    });
  });

  it("rejects forbidden commands, malformed responses, and bounded bodies", async () => {
    await expect(
      callKeposBridge({
        endpoint: "https://example.test/route",
        commands: { response_length: "long" },
        fetch: async () => Response.json({ output: "never" }),
      }),
    ).rejects.toThrow("unsupported command");

    await expect(
      callKeposBridge({
        endpoint: "https://example.test/route",
        commands: { time: [{ utc_offset: "+08:00" }] },
        fetch: async () => Response.json({ results: [] }),
      }),
    ).rejects.toThrow("invalid response");

    const oversizedResponse = "x".repeat(KEPOS_BRIDGE_MAX_RESPONSE_BYTES + 1);
    await expect(
      callKeposBridge({
        endpoint: "https://example.test/route",
        commands: { time: [{ utc_offset: "+08:00" }] },
        fetch: async () => new Response(oversizedResponse),
      }),
    ).rejects.toThrow(`${KEPOS_BRIDGE_MAX_RESPONSE_BYTES} byte limit`);

    await expect(
      callKeposBridge({
        endpoint: "https://example.test/route",
        commands: {
          search_query: [{ q: "x".repeat(KEPOS_BRIDGE_MAX_REQUEST_BYTES) }],
        },
        fetch: async () => Response.json({ output: "never" }),
      }),
    ).rejects.toThrow("64 KiB limit");

    await expect(
      callKeposBridge({
        endpoint: "https://example.test/route",
        commands: { time: [{ utc_offset: "+08:00" }] },
        fetch: async () => {
          throw new Error("secret request text");
        },
      }),
    ).rejects.toThrow("Kepos Bridge request failed");
    await expect(
      callKeposBridge({
        endpoint: "https://example.test/route",
        commands: { time: [{ utc_offset: "+08:00" }] },
        fetch: async () => {
          throw new Error("secret request text");
        },
      }),
    ).rejects.not.toThrow("secret request text");
  });

  it("forwards cancellation and validates complete routes", async () => {
    const controller = new AbortController();
    const pending = callKeposBridge({
      endpoint: "https://example.test/route",
      commands: { time: [{ utc_offset: "+08:00" }] },
      signal: controller.signal,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    controller.abort();
    await expect(pending).rejects.toThrow("Operation aborted");

    expect(isValidKeposBridgeEndpoint("http://127.0.0.1:8787/route")).toBe(
      true,
    );
    for (const endpoint of [
      "relative/path",
      "ftp://example.test/route",
      "https://user:pass@example.test/route",
      "https://example.test/route?x=1",
      "https://example.test/route#fragment",
    ])
      expect(isValidKeposBridgeEndpoint(endpoint)).toBe(false);
  });
});
