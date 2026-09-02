# @guionai/dsh-web

DeepSeek Harness 0.1.2-alpha.3 Web bundle and browser settings client for Guion Web.

Install it into the existing Web profile:

```bash
dsh plugin --profile web add @guionai/dsh-web
```

The package owns the Web profile patch and does not require a custom profile or
PTC preset. It leaves the root `tool-web` row disabled and routes stock PTC's
batched `web_search` through the Guion provider seam.

Provider selection is explicit and persists in the `guionai-web` settings
namespace. Exa, Brave, and DeepSeek API keys use namespaced write-only DSH credentials;
settings expose only configured/source/writable metadata. The credential-free
`kepos-bridge` provider uses the complete non-secret route configured in the
card (default `http://codex-bridge.localhost:17480/codex/web-search`). While it is selected,
the package registers `web_weather`, `web_sports`, `web_finance`, and `web_time`;
switching to Exa, Brave, or DeepSeek removes those four schemas. DeepSeek uses
the same provider picker and write-only `DEEPSEEK_API_KEY` credential workflow
as the other hosted providers, makes one auxiliary model call per search, and
returns normalized ranked sources. It has no endpoint input; the endpoint
field in this card is for Kepos Bridge only.
The route is a complete absolute `http:` or `https:` URL; credentials, query
strings, and fragments are rejected and its path is used exactly as entered.

The published package is a dual host/browser bundle. Its host and client
artifacts, profile patch, and exact DSH `0.1.2-alpha.3` peer contract are included
in the npm package. Search, HTTP page rendering, page-link discovery, optional browser rendering,
Context7 documentation, and Sourcegraph all run in-process through the bundled
Guion Web core. `web_fetch` has two page-rendering modes: HTTP (the default) and
explicit `render: "browser"` with required `waitMs` (an integer from 0 through
30,000) for client-rendered pages through a host-installed
`agent-browser`
executable. To enable that optional capability, install
[agent-browser](https://github.com/vercel-labs/agent-browser) separately with
`npm install --global agent-browser` followed by `agent-browser install`. Its
browser runtime is managed outside this package; the compatible executable must
be directly runnable from `PATH` without a shell. The renderer is supported on
macOS and Linux, is not an npm dependency, and never reuses persistent browser
state or credentials.

`web_links` lists up to 100 unique HTTP(S) anchors from the original page DOM,
so it includes navigation and other links that readable-content extraction drops.
It uses the same HTTP default and explicit `render: "browser"` / required
`waitMs` contract as `web_fetch`.

Long `web_fetch` documents with navigable headings return a navigation tree
automatically. A headingless long document uses the normal bounded response.
Use `full: true` for complete Markdown or pass a returned `section_id` to
continue with one section; those fields are mutually exclusive.

Rendered requests are bounded and constrained to the requested hostname,
`*.<requested-hostname>` (the target and its subdomains), and this fixed common
CDN list: `cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`,
`ajax.googleapis.com`, `fonts.googleapis.com`, `fonts.gstatic.com`, and `esm.sh`.
The caller cannot widen the list. A redirect, API, frame, worker, socket, or
other dependency on an unknown domain fails closed as
`render_domain_not_allowed`; increasing `waitMs` will not help. For example,
retry a shell with `render: "browser", waitMs: 2000`, then explicitly
retry with a longer wait such as `waitMs: 10000` or abandon the page. Report a
likely missing first-party or common-CDN domain at
https://github.com/guionai/web/issues/new, including the page URL and blocked
domain without credentials or page secrets.

Literal and DNS-resolved private/reserved targets are rejected before launch,
but this is only a browser-level hostname boundary: an allowlisted malicious
hostname can change its DNS answer to a private address after validation (DNS
rebinding), and this backend provides no operating-system host-egress
isolation. It is not a complete SSRF boundary for arbitrary untrusted URLs in
a public or multi-tenant service; that deployment needs a per-connection
SSRF-filtering proxy or container/microVM egress isolation.
