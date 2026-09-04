# Guion Web personal HTTP service

The personal service is a single-trust-boundary JSON API. It exposes exactly
three `POST` routes: `/api/v1/web/search`, `/api/v1/web/fetch`, and `/api/v1/web/links`. It is intended
for an operator and trusted agents, not for public or multi-tenant traffic.

## Calling the service

Send `Content-Type: application/json` and a JSON request body. Successful
responses are JSON and preserve the shared Guion page-reading vocabulary.
Unknown fields, malformed JSON, missing required fields, and values outside the
constraints below are rejected before an operation is called.

### `POST /api/v1/web/search`

Request:

```json
{ "query": "AbortSignal" }
```

`query` is a non-empty string. The service chooses providers server-side; a
caller cannot select a provider, supply credentials, or override the Bridge
route. With no `WEB_SEARCH_PROVIDER`, search tries the server-local Kepos
Bridge first. A successful empty Bridge result is returned as-is. If Bridge
fails for a non-cancellation reason, the service retries Exa once and requires
a non-empty `EXA_API_KEY` at startup. Set the server-local
`WEB_SEARCH_PROVIDER=deepseek` to require `DEEPSEEK_API_KEY` and call DeepSeek
only; that path has no Bridge or Exa fallback.

Response `200`:

```json
{
  "provider": "Kepos Bridge",
  "results": [
    {
      "title": "...",
      "link": "https://example.test",
      "snippet": "...",
      "position": 1
    }
  ]
}
```

`provider` is `"Kepos Bridge"`, `"Exa"`, or `"DeepSeek"`; each result has string `title`,
`link`, and `snippet` fields plus an integer `position`.

### `POST /api/v1/web/fetch`

Request:

```json
{
  "url": "https://example.test/article",
  "render": "http",
  "section_id": "7i"
}
```

`url` must be an absolute `http:` or `https:` URL. `render` is optional and
must be exactly `"http"` or `"browser"`; omission selects `"http"`. `waitMs`
is an integer from 0 through 30,000, required with `render: "browser"` and
forbidden with `render: "http"` (or when `render` is omitted). `mode` is
optional and defaults to `"auto"`; it must be one of `"auto"`, `"full"`,
or `"tree"`. A non-empty `section_id` may be supplied with omitted mode or
`mode: "auto"` to retrieve that section; it is rejected with `"full"` or
`"tree"`.

HTTP rendering fetches the page with Node HTTP, linkedom, and Defuddle.
Browser rendering delegates the raw DOM request to the internal Browser
Rendering Gateway; the gateway's browser executable is not a public request
value. Configure its origin with the server-local `BROWSER_GATEWAY_URL`
environment variable when running the GHCR image. A local/npm `web serve` with
supplied direct operations keeps its direct browser capability; the image sets
`GUIONAI_HTTP_IMAGE=1` to select the gateway-only path. Browser rendering is
never selected automatically, and the service does not fall back between
renderers. If gateway configuration is missing or the gateway rejects, times
out, or returns an invalid response, the image operation fails explicitly with
a `render_*` capability error.

The shared module owns the 5,000-character automatic-tree policy. An `"auto"`
request for an unsectioned document longer than that threshold with navigable
headings returns `mode: "tree"` with stable section IDs. Use one of those IDs
in a subsequent request with omitted mode or `mode: "auto"` to retrieve a
section. A short automatic response and a headingless long document report
`mode: "auto"`; the latter remains bounded by the Core content limit.
`mode: "full"` returns the complete extracted Markdown without that limit and
reports `mode: "full"`. `mode: "tree"` always returns the heading-tree
representation, including the explicit no-headings result, and reports
`mode: "tree"`. Section requests report `mode: "section"`. Every response
includes `truncated`, which is true only when ordinary automatic content was
cut by the Core content-length limit.

Response `200`:

```json
{
  "url": "https://example.test/article",
  "mode": "full",
  "content": "# Article\n...\n",
  "truncated": false
}
```

### `POST /api/v1/web/links`

Request:

```json
{
  "url": "https://example.test/article",
  "limit": 50,
  "render": "browser",
  "waitMs": 0
}
```

`url`, `render`, and `waitMs` follow the Fetch rules. `limit` is optional,
defaults to 100, and must be an integer from 1 through 100. Links are read from
the source DOM rather than Defuddle's article body, deduplicated, and limited
to HTTP(S) `a[href]` destinations.

Response `200`:

```json
{
  "url": "https://example.test/article",
  "links": [{ "text": "Guide", "url": "https://example.test/guide" }],
  "truncated": false
}
```

## Errors

Every error is a bounded JSON object with this shape:

```json
{ "code": "invalid_request", "message": "Request validation failed" }
```

`details` is optional and contains only safe, documented fields. The service
uses these status codes:

| Status | Meaning                                                                  |
| -----: | ------------------------------------------------------------------------ |
|  `400` | Invalid JSON, unknown fields, invalid values, or renderer/wait mismatch. |
|  `499` | The client cancelled the request.                                        |
|  `502` | An upstream provider, page fetch, renderer, or response contract failed. |
|  `504` | An upstream operation timed out.                                         |
|  `404` | The path is not one of the three retained routes.                        |

A browserless Fetch failure may use `javascript_rendering_may_be_required` and
include `details: { "retryableWithRender": true, "suggestedArguments": {
"render": "browser", "waitMs": 2000 } }`. A renderer allowlist failure uses
`render_domain_not_allowed` with `retryable: false`, the report URL, and a
validated blocked hostname when available. Increasing `waitMs` does not fix an
allowlist failure. Error responses never include credentials or raw upstream
response bodies.

## Configuration and OpenAPI

Credentials, the optional `KEPOS_BRIDGE_ENDPOINT`, the optional image-only
`BROWSER_GATEWAY_URL`, and the optional server-local
`WEB_SEARCH_PROVIDER=deepseek` selection are environment variables. The
image sets `GUIONAI_HTTP_IMAGE=1`; local/npm servers leave that marker unset and
retain their direct operations. The gateway URL is a base URL; image mode calls
its `POST /api/render` raw-render operation with `{ "url", "waitMs" }`. They
are not accepted in request bodies.
DeepSeek performs one
auxiliary model call per search; callers receive only normalized results and do
not need to know the Messages/tool wire protocol. The route
schemas in [`packages/web/src/http.ts`](../packages/web/src/http.ts) are the
machine-readable source of truth. The build generates a version-matched
OpenAPI 3.1 artifact at `packages/web/dist/openapi.yaml`; releases attach that
file as the downloadable `openapi.yaml` asset. This document is its
human-readable companion and is not an independently versioned schema.
