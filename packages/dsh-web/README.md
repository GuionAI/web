# @guionai/dsh-web

DeepSeek Harness 0.1.2-rc.1 Web bundle and browser settings client for Guion Web.

Generate compatible stock-equivalent presets before installing or activating
the bundle in the existing Web profile:

```bash
web dsh sync
dsh plugin --profile web add @guionai/dsh-web
web dsh doctor
```

`web dsh sync` reads the installed official
`@deepseek-ai/dsh-agent-presets@0.1.2-rc.1` package and creates marked copies
with the familiar `standard`, `ptc`, `cordis`, and `minimal` ids in
`${DSH_HOME:-$HOME/.dsh}/.agent-presets`. It removes only the top-level
official `tool-web` row from `standard`, `ptc`, and `cordis`; Minimal is copied
unchanged. Sync is idempotent and refreshes only directories bearing Guion's
marker. It refuses an unmarked same-id directory, so a user's custom preset is
never overwritten or deleted. Run sync again after upgrading DSH. `doctor` is
read-only, reports missing/incomplete/conflicting/stale managed copies, and
exits nonzero until all four are current.

The bundle patch sets `includeShippedRoot: false`, `includeUserRoot: true`,
and `default: standard`. This hides the official shipped duplicates while
retaining Yuki and all other ordinary user presets. Existing sessions,
credentials, and deployed profiles are not migrated automatically; activate or
deploy the bundle only after sync and doctor succeed.

The package owns the global DSH Research Surface and does not require a custom
profile. It directly registers `web_search`, `web_fetch`, `web_links`,
`web_docs`, and `web_source_search`; while Kepos Bridge is selected it also
registers `web_weather`, `web_sports`, `web_finance`, and `web_time`. Managed
stock-equivalent presets omit the scoped `tool-web` row so both native and PTC
modes inherit these same global registrations.

The profile patch disables the official DSH Web registry, official search and
fetch providers, and official `tool-web`; it does not load or depend on the
official `@deepseek-ai/dsh-web` package.

The Guion schemas are complete and shared by every managed preset:
`web_search` takes one to four trimmed queries and preserves concurrent,
deterministic partial results; `web_fetch` takes `mode: "auto" | "full" |
"tree"`, optional `section_id` with omitted/`auto` mode, and explicit
`render: "http" | "browser"` with browser `waitMs` from 0 through 30,000;
`web_links` has the same renderer contract. `web_docs` and
`web_source_search` retain their existing Context7 and Sourcegraph contracts.

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

`web_search` accepts one to four trimmed, non-empty queries, starts valid
queries concurrently, interleaves successful results deterministically, and
keeps partial successes when one query fails. If every query fails it reports
the failed queries clearly. The selected provider and its credential are read
when each search executes, so the next call observes a settings change without
remounting a preset. Search output uses the same bounded model-facing text
conventions as the other Guion adapters.

The published package is a dual host/browser bundle. Its host and client
artifacts, profile patch, and exact DSH `0.1.2-rc.1` peer contract are included
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
automatically when `mode: "auto"` (the default). A headingless long document
uses the normal bounded response. Set `mode: "full"` for complete Markdown,
`mode: "tree"` to force the heading tree, or supply a returned `section_id`
with omitted mode or `mode: "auto"` to continue with one section. Input mode
`"section"` is not supported, and `section_id` is rejected with `"full"` or
`"tree"`. Ordinary automatic document results report `mode: "auto"`; tree,
full, and section results report `"tree"`, `"full"`, and `"section"`.
Every result includes `truncated`, which is true only when automatic content
was cut by the content-length limit.

For example, request a tree and then continue with one returned section:

```json
{ "url": "https://example.test/article", "mode": "tree" }
{ "url": "https://example.test/article", "section_id": "7i" }
```

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
