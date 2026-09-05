# Guion Web

Guion Web is a Node.js web research toolkit. It provides Exa, Brave, DeepSeek,
or a managed Kepos Bridge search endpoint,
Context7 library documentation lookup, Sourcegraph public code search, page-link
discovery, and two page-rendering modes through a CLI, stdio MCP server, personal
HTTP service, Pi extension, and DeepSeek Harness (DSH) integration: HTTP
HTML-to-Markdown extraction and explicit browser rendering for client-rendered
pages on supported hosts.

> **DSH setup note:** Run `web dsh sync` before installing the DSH bundle and
> `web dsh doctor` afterward. The workflow creates Guion-managed copies of the
> familiar stock preset ids and hides their official shipped duplicates while
> preserving ordinary user presets.

## Install and configure

Node.js 20 or later is required. `@guionai/web` exposes its `web` executable,
stdio MCP server, and personal HTTP service; it does not provide a root
JavaScript or TypeScript SDK. Use the Pi or DSH packages for those host
integrations.

```bash
npm install --global @guionai/web
# or run without a global install
npx @guionai/web --help
```

Search needs one provider credential for Exa, Brave, or DeepSeek. If Exa and
Brave are both present, Exa is selected by default; DeepSeek is never selected
implicitly. Select a provider explicitly with `--provider exa`,
`--provider brave`, `--provider deepseek`, or `--provider kepos-bridge`.
DeepSeek makes one auxiliary model call using its native web-search tool and
returns the same normalized ranked URL/title/snippet results as the other
providers. Kepos Bridge uses the bundled default route unless it runs in DSH,
whose live settings card can override the route.
Context7 works anonymously when its key is absent.

The HTTP service always uses the Bridge-to-Exa policy by default and requires a
non-empty `EXA_API_KEY` for its retry. Set the server-local
`WEB_SEARCH_PROVIDER=deepseek` to select DeepSeek instead; this requires a
non-empty `DEEPSEEK_API_KEY` and does not fall back to Bridge or Exa when the
DeepSeek request fails. HTTP clients cannot select a provider, pass credentials,
or override the Bridge route per request. Set `KEPOS_BRIDGE_ENDPOINT` to replace the default route
(`http://codex-bridge.localhost:17480/codex/web-search`); it must be a complete
HTTP(S) URL without credentials, query, or fragment.

```bash
export EXA_API_KEY="..."
# or
export BRAVE_API_KEY="..."
# for explicit DeepSeek selection in CLI, MCP, Pi, or DSH
export DEEPSEEK_API_KEY="..."
# optional, for authenticated Context7 requests
export CONTEXT7_API_KEY="..."
# optional complete Bridge route for `web serve`
export KEPOS_BRIDGE_ENDPOINT="http://127.0.0.1:8787/codex/web-search"
# optional Browser Rendering Gateway origin for `web serve` browser requests
export BROWSER_GATEWAY_URL="http://browser-gateway"
# HTTP/Pi: select DeepSeek server-side (HTTP clients still send {"query":"..."})
export WEB_SEARCH_PROVIDER="deepseek"
```

Do not put credentials in command arguments or commit them. The CLI reads these
environment variables directly; it does not load a dotenv file or an older
application configuration path.

## Personal HTTP service

Run the service with the server-local environment above. Leave
`WEB_SEARCH_PROVIDER` unset for Bridge-to-Exa; set it to `deepseek` for the
DeepSeek-only path:

```bash
web serve --host 0.0.0.0 --port 8787
# or use the published image
docker run --rm -p 8787:8787 \
  -e EXA_API_KEY="$EXA_API_KEY" \
  -e KEPOS_BRIDGE_ENDPOINT="http://host.docker.internal:17480/codex/web-search" \
  -e BROWSER_GATEWAY_URL="http://host.docker.internal:8788" \
  ghcr.io/guionai/web:v0.1.0
```

Every HTTP operation is a versioned JSON `POST` route. Request and response schemas
are generated into `openapi.yaml` from the same route definitions:

| Route                | Request                                                   | Purpose                                                         |
| -------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| `/api/v1/web/search` | `{ "query": "..." }`                                      | Server-selected search: Bridge→Exa by default, or DeepSeek only |
| `/api/v1/web/fetch`  | `{ "url", "mode?", "section_id?", "render?", "waitMs?" }` | Fetch Markdown                                                  |
| `/api/v1/web/links`  | `{ "url", "limit?", "render?", "waitMs?" }`               | List page HTTP(S) links                                         |

The complete human-readable contract is in the [HTTP service reference](docs/http-service.md).

Search keeps a successful empty Bridge result, retries Exa exactly once for a
non-cancellation Bridge failure when no server provider is selected, and
reports the provider in its response. DeepSeek selection is server-local and
has no automatic fallback. The request remains `{ "query": "..." }` in every
case.
Weather, sports, finance, and time are not exposed because the configured
providers do not offer contract-equivalent official typed data APIs. Invalid JSON
bodies, unknown fields, and invalid typed values are rejected before an upstream call.
Upstream failures are bounded JSON errors and never include credentials or raw
provider response bodies.
Error responses use a stable `{ "code", "message", "details"? }` JSON shape;
upstream failures use 502 (or 504 for an upstream timeout), while client
cancellation is reported as 499.

Fetch and Links use HTTP rendering when `render` is omitted (or set to
`"http"`). Browser rendering is explicit and requires both `render: "browser"`
and an integer `waitMs` from 0 through 30,000; HTTP rendering never silently
switches backends. A local/npm `web serve` keeps its supplied direct operations.
The GHCR image sets `GUIONAI_HTTP_IMAGE=1` and sends browser requests to the
server-local Browser Rendering Gateway configured by `BROWSER_GATEWAY_URL`.
The GHCR image contains no Chromium or `agent-browser`; an absent, unreachable,
overloaded, or failed gateway returns an explicit browser-render failure while
ordinary HTTP rendering remains available.

This is a Personal Web Service: a single-trust-boundary deployment for its
operator and agents. It is not hardened for public or multi-tenant exposure;
SSRF/egress isolation, browser sandboxing, quotas, and authentication remain
deferred in `.scratch/defered/public-http-service-security.md`.

## CLI

`web` has human-readable output by default. Add `--json` for exactly one JSON
document on stdout, which is useful for automation.
Run `web --version` (or `web -V`) to print the installed package version.

```bash
web search --provider exa -- "Node AbortSignal"
web search --provider deepseek -- "Node AbortSignal"
web search --provider kepos-bridge -- "Node AbortSignal"
web fetch https://example.com/article
web fetch https://example.com/article --section introduction
web fetch https://example.com/article --mode auto --section introduction
web fetch https://example.com/article --mode tree
web fetch https://example.com/article --mode full
web links https://example.com/article --limit 50
web docs resolve react
web docs fetch /facebook/react --topic hooks --tokens 2000
web sgraph --count 10 -- "repo:^github\\.com/nodejs/node$ AbortSignal"
```

Use `--` before a search or Sourcegraph query that begins with a hyphen. `fetch`
supports `--mode auto|full|tree`; omitted mode means `auto`. `--section` may be
used with omitted mode or `--mode auto` to retrieve a section, and is rejected
with `--mode full` or `--mode tree`. Long extracted documents with navigable
headings automatically return a heading tree so a later request can retrieve a
stable `section_id`. Ordinary automatic document results report `mode: "auto"`;
heading-tree, explicit full-document, and section results report `"tree"`,
`"full"`, and `"section"` respectively. A headingless long document uses the
normal bounded automatic response. `truncated` is true only when that response
is cut by the content-length limit. `mode: "full"` returns the complete
extracted Markdown, while `mode: "tree"` always returns the heading-tree
representation, including the explicit no-headings result. `links` lists up to
100 unique HTTP(S) anchors from the original page DOM.

## MCP

Run the stdio server with the same credential environment:

```bash
web mcp
# Pin search selection for the lifetime of this MCP process:
web mcp --provider brave
web mcp --provider deepseek
web mcp --provider kepos-bridge
```

The server exposes six read-only tools: `search`, `fetch`, `links`, `docs_resolve`,
`docs_fetch`, and `source_search`. Its stdout is reserved for MCP protocol
messages; diagnostics go to stderr. For a client-rendered page, explicitly call
`fetch` or `links` with `render: "browser"` and an integer `waitMs`; this optional
retry requires a host-installed executable and never happens automatically.
The `fetch` tool accepts input `mode: "auto" | "full" | "tree"` (default
`"auto"`). Pass a returned `section_id` with omitted mode or `mode: "auto"`
to retrieve that section; `mode: "full"` and `mode: "tree"` reject
`section_id`. Results include `mode: "auto" | "full" | "tree" | "section"`
and `truncated`, which is true only when content was cut by the length limit.

## Pi

Install the independently bundled Pi extension:

```bash
pi install npm:@guionai/pi-web
```

It registers `web_search`, `web_fetch`, `web_links`, `web_docs`, and `web_source_search` and calls
the bundled core in-process. Pi and TypeBox are peer dependencies supplied by
the host; no CLI executable or MCP configuration is required. `web_fetch` uses
HTTP rendering by default and can explicitly use `render: "browser"` with
an integer `waitMs` when its host provides that optional executable.
Its navigation input is `mode: "auto" | "full" | "tree"` (default `"auto"`);
`section_id` with omitted/`"auto"` mode retrieves a section, while full/tree
reject it. Results report `mode: "auto" | "full" | "tree" | "section"` and a
`truncated` flag that only indicates content cut by the length limit.
`web_links` uses the same explicit rendering contract and lists HTTP(S) anchors
from the original page DOM.

Set `WEB_SEARCH_PROVIDER=kepos-bridge` before starting Pi to select the
credential-free Kepos Bridge provider, or `WEB_SEARCH_PROVIDER=deepseek` with
`DEEPSEEK_API_KEY` for explicit DeepSeek search. Pi uses the bundled default
Bridge route; only DSH exposes a route setting. DeepSeek is never selected by
the presence of its key alone.

## DSH

The bundle uses the familiar stock preset ids, but its compatible copies are
owned by Guion in the DSH user preset root. Synchronize those copies before
installing or activating the profile bundle:

```bash
web dsh sync
dsh plugin --profile web add @guionai/dsh-web
web dsh doctor
```

`web dsh sync` reads the installed official
`@deepseek-ai/dsh-agent-presets@0.1.2-rc.1` package and creates marked,
compatible `standard`, `ptc`, `cordis`, and `minimal` copies. It removes only
the top-level official `tool-web` row from the first three; Minimal is copied
unchanged because it already omits that row. The command is idempotent and
refreshes only directories bearing Guion's marker. An existing unmarked
same-id directory is never overwritten: move it or choose another id before
retrying. Run sync again after upgrading the supported DSH runtime. The
read-only doctor command reports missing, incomplete, stale, and conflicting
copies and exits nonzero when the roster is not ready.

The bundle's preset roster sets `includeShippedRoot: false`,
`includeUserRoot: true`, and `default: standard`. This hides all official
shipped duplicates while preserving Yuki and every other ordinary user
preset. Existing sessions, credentials, and deployed profiles are not
migrated automatically; activate or deploy the bundle separately after a
successful sync and doctor run.

The profile patch disables the official DSH Web registry, search/fetch providers,
and `tool-web`, then registers Guion's complete DSH Research Surface directly.
Its settings UI stores provider selection and the complete non-secret Kepos
Bridge route (default `http://codex-bridge.localhost:17480/codex/web-search`)
and manages namespaced write-only credentials, including a write-only DeepSeek
API key. DeepSeek uses the same provider picker/key workflow and exposes no
DeepSeek endpoint field. Selecting Kepos Bridge additionally exposes
`web_weather`, `web_sports`, `web_finance`, and `web_time`; these tools are
removed when another provider is selected. The host DSH target is
`0.1.2-rc.1`; its packages and React are peers supplied by DSH.
`web_fetch` uses HTTP rendering by default and can explicitly use
`render: "browser"` with an integer `waitMs` on a host that supplies the
optional executable.
Its navigation input uses the same `mode` and `section_id` contract as the
other adapters: input mode is `auto|full|tree` (default `auto`), and omitted or
`auto` mode plus `section_id` retrieves a section. Results report
`auto|full|tree|section` and `truncated`.
`web_links` uses the same explicit rendering contract and lists HTTP(S) anchors
from the original page DOM.

Guion owns `web_search`, `web_fetch`, `web_links`, `web_docs`, and
`web_source_search` in both native and PTC presentation modes. `web_search`
accepts one to four trimmed queries, runs them concurrently, deterministically
merges partial successes, and reports total failure clearly. `web_fetch`
accepts `mode: "auto" | "full" | "tree"`, optional `section_id` with omitted
or `auto` mode, `render: "http" | "browser"`, and browser `waitMs` from 0
through 30,000. `web_links` has the same rendering and wait contract. The
complete schemas are inherited by every managed stock-equivalent preset.

## Page-rendering modes

`web fetch` has two renderers. `http` (the default) uses Node `fetch`, `linkedom`,
and Defuddle for HTML-to-Markdown extraction from static, SSR, and pre-rendered
pages. `browser` renders client-side pages through the host capability: `web
serve` delegates to its configured Browser Rendering Gateway, while CLI, MCP,
Pi, and DSH use the separately installed `agent-browser` capability. HTTP
rendering is used by default; choose browser explicitly when needed. The
implementation never falls back automatically:

```bash
web fetch https://example.com/app --render=browser --wait=2000
# If it is still incomplete, retry explicitly with more time, or abandon it:
web fetch https://example.com/app --render=browser --wait=10000
```

`web links` uses the same HTTP or explicit browser-rendered source, but parses
the original DOM rather than Defuddle output so navigation and other links outside
the readable article remain discoverable. It returns only HTTP(S) `a[href]`
destinations, deduplicated and capped at 100 by default.

`--wait` is mandatory with `--render=browser`, including `--wait=0`, and
accepts only an integer from 0 through 30,000 milliseconds. HTTP `fetch`
or `links` requests must not provide `--wait`. The same `render: "browser"` and required
`waitMs` fields are available on the MCP `fetch`/`links`, Pi `web_fetch`/`web_links`, and DSH
`web_fetch`/`web_links` tools. An HTTP-rendering failure may return the structured
`javascript_rendering_may_be_required` hint with the 2,000 ms suggestion; the
agent decides whether to retry with a longer wait or abandon the page.

Direct rendering is an optional host capability for CLI, MCP, Pi, and DSH. If
you choose to use it, install
[agent-browser](https://github.com/vercel-labs/agent-browser) separately on the
host:

```bash
npm install --global agent-browser
agent-browser install
```

`agent-browser install` manages its own browser runtime; Guion packages never
run it, bundle it, or reuse browser credentials. A compatible executable must be
directly runnable from `PATH` without a shell. The renderer is supported on
macOS and Linux hosts. HTTP rendering remains available, and the three npm
packages remain installable when `agent-browser` is absent.

A rendered session is fresh and non-persistent. Before launch, the target must
be an HTTP(S) public hostname or address. The browser allowlist then contains
only the requested hostname, `*.<requested-hostname>` (the target and its
subdomains), and this fixed common-CDN set:

- `cdn.jsdelivr.net`
- `unpkg.com`
- `cdnjs.cloudflare.com`
- `ajax.googleapis.com`
- `fonts.googleapis.com`
- `fonts.gstatic.com`
- `esm.sh`

The caller cannot widen this list. Redirects, APIs, frames, workers, sockets,
or other dependencies on unknown domains fail closed as
`render_domain_not_allowed`; increasing `waitMs` will not help. Report a likely
missing first-party or common-CDN domain at
https://github.com/guionai/web/issues/new, including the page URL and blocked
domain. Do not include credentials or page secrets in an issue.

This is a browser-level hostname boundary, not complete SSRF protection or a
host egress firewall. Literal and DNS-resolved private/reserved targets are
rejected before launch, but an allowlisted malicious hostname can change its
DNS answer to a private address after validation (DNS rebinding), and there is
no operating-system host-egress isolation here. Do not use this backend for
arbitrary untrusted URLs in a public or multi-tenant service without a
per-connection SSRF-filtering proxy or container/microVM egress isolation.

## Development

This is a pnpm workspace. Install dependencies and run the same local gates
used by CI:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
pnpm test:release
pnpm test:pack
pnpm test:image
```

`test:release` uses disposable manifests to exercise tag-version
synchronization. `test:pack` runs each public package's packed installation or
host-loading contract in test-owned temporary directories. `test:image` builds a
test-owned disposable Docker image, runs it against a fake `/api/render` gateway,
and verifies the image has no browser executable.

## Releases

A `v<semver>` tag is the release source of truth for all three public packages:
`@guionai/web`, `@guionai/pi-web`, and `@guionai/dsh-web`. The release preflight
synchronizes its checkout manifests from that tag, then completes formatting,
typechecking, build, tests, release-version checks, packed smoke tests, and the
Docker image contract
before any publication begins.

Three independent, non-fail-fast protected `npm` Environment matrix cells then
publish one package each through npm Trusted Publishing with provenance. The
synchronized version selects npm's `latest` tag for stable SemVer and `beta` for
a prerelease. A matching immutable-tagged image is published to
`ghcr.io/guionai/web:<tag>` with the `web serve` entrypoint. The image delegates
explicit browser rendering to the configured internal Browser Rendering
Gateway and contains no browser executable. After all three npm cells and the image job succeed,
the workflow creates the GitHub release with generated notes, source archives,
and the build-generated `openapi.yaml` asset. The asset is generated from the
same Hono route schemas as the image and package; it is not checked in or
versioned independently. It publishes no binaries or platform archives.

If publication partially fails, use GitHub Actions **Re-run failed jobs**. Never
use **Re-run all jobs**: npm versions are immutable, so the jobs that already
published successfully must not run again.

### First beta bootstrap and Trusted Publishing

Do this once after the release commit is merged, before enabling routine OIDC
releases:

1. Check out a clean intended release commit and choose a synchronized beta
   version such as `0.1.0-beta.1`.
2. With a maintainer npm account that has `@guionai` publish permission and 2FA,
   run `node scripts/sync-version.mjs 0.1.0-beta.1`, then run the build, test,
   pack, and `node scripts/release-dry-run.mjs 0.1.0-beta.1` gates.
3. From each public package directory, publish the synchronized beta with
   `npm publish --access public --tag beta`. This bootstrap is authenticated by
   the maintainer; do not pass provenance outside the GitHub OIDC release job.
4. In npm package settings, create one GitHub Trusted Publisher relationship
   for each of `@guionai/web`, `@guionai/pi-web`, and `@guionai/dsh-web`. Each
   must target repository `guionai/web`, workflow `.github/workflows/release.yaml`,
   and the protected `npm` Environment.
5. Verify all three relationships and npm publishing-access policies in npm,
   then enable/tag the routine release workflow. It uses GitHub OIDC with no
   npm token and requests provenance for every normal publication.

Never overwrite or unpublish a version. For a partial GitHub release, rerun
only its failed publish cells.
