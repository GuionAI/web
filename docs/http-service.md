# Guion Web personal HTTP service

The personal service is a single-trust-boundary JSON API. It exposes exactly
three `POST` routes: `/v1/search`, `/v1/fetch`, and `/v1/links`. It is intended
for an operator and trusted agents, not for public or multi-tenant traffic.

## Calling the service

Send `Content-Type: application/json` and a JSON request body. Successful
responses are JSON and preserve the shared Guion page-reading vocabulary.
Unknown fields, malformed JSON, missing required fields, and values outside the
constraints below are rejected before an operation is called.

### `POST /v1/search`

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

### `POST /v1/fetch`

Request:

```json
{
  "url": "https://example.test/article",
  "render": "http",
  "full": false,
  "section_id": "7i"
}
```

`url` must be an absolute `http:` or `https:` URL. `render` is optional and
must be exactly `"http"` or `"browser"`; omission selects `"http"`. `waitMs`
is an integer from 0 through 30,000, required with `render: "browser"` and
forbidden with `render: "http"` (or when `render` is omitted). `full` is an
optional boolean. `section_id` is an optional non-empty string returned in a
navigation tree. `full: true` and `section_id` cannot be sent together.

HTTP rendering fetches the page with Node HTTP, linkedom, and Defuddle.
Browser rendering invokes the operator-installed `agent-browser` executable
through the isolated renderer implementation; the executable name is not a
public request value. Browser rendering is never selected automatically, and
the service does not fall back between renderers.

The shared module owns the 5,000-character automatic-tree policy. A non-full,
unsectioned document longer than that threshold with navigable headings returns
`mode: "tree"` with stable section IDs. Use one of those IDs in a subsequent
request to retrieve a section. A long document without headings uses the normal
bounded `mode: "full"` response because it has no section to navigate. The
`full: true` option returns the complete extracted Markdown without the Core
content limit. A short result uses `mode: "full"`; a section request uses
`mode: "section"`.

Response `200`:

```json
{
  "url": "https://example.test/article",
  "mode": "full",
  "content": "# Article\n...\n"
}
```

### `POST /v1/links`

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

Credentials, the optional `KEPOS_BRIDGE_ENDPOINT`, and the optional
server-local `WEB_SEARCH_PROVIDER=deepseek` selection are environment
variables. They are not accepted in request bodies. DeepSeek performs one
auxiliary model call per search; callers receive only normalized results and do
not need to know the Messages/tool wire protocol. The route
schemas in [`packages/web/src/http.ts`](../packages/web/src/http.ts) are the
machine-readable source of truth. The build generates a version-matched
OpenAPI 3.1 artifact at `packages/web/dist/openapi.yaml`; releases attach that
file as the downloadable `openapi.yaml` asset. This document is its
human-readable companion and is not an independently versioned schema.
