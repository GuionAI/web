# Guion Web

Guion Web is a Node.js web research toolkit. It provides Exa, Brave, or a
managed Kepos Bridge search endpoint,
Context7 library documentation lookup, Sourcegraph public code search, page-link
discovery, and two page-fetch backends through a CLI, stdio MCP server, personal
HTTP service, Pi extension, and DeepSeek Harness (DSH) integration: direct
HTML-to-Markdown extraction and explicit `agent-browser` rendering for
client-rendered pages on supported hosts.

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

Search needs one provider credential for Exa or Brave. If both are present, Exa
is selected by default; select a provider explicitly with `--provider exa`,
`--provider brave`, or `--provider kepos-bridge`. Kepos Bridge uses the bundled
default route unless it runs in DSH, whose live settings card can override the
route.
Context7 works anonymously when its key is absent.

The HTTP service always requires a non-empty `EXA_API_KEY`: it tries the
server-local Kepos Bridge route first and retries Exa once when Bridge fails.
HTTP clients cannot select a provider, pass credentials, or override the Bridge
route per request. Set `KEPOS_BRIDGE_ENDPOINT` to replace the default route
(`http://codex-bridge.localhost:17480/codex/web-search`); it must be a complete
HTTP(S) URL without credentials, query, or fragment.

```bash
export EXA_API_KEY="..."
# or
export BRAVE_API_KEY="..."
# optional, for authenticated Context7 requests
export CONTEXT7_API_KEY="..."
# optional complete Bridge route for `web serve`
export KEPOS_BRIDGE_ENDPOINT="http://127.0.0.1:8787/codex/web-search"
```

Do not put credentials in command arguments or commit them. The CLI reads these
environment variables directly; it does not load a dotenv file or an older
application configuration path.

## Personal HTTP service

Run the service with the server-local environment above:

```bash
web serve --host 0.0.0.0 --port 8787
# or use the published image
docker run --rm -p 8787:8787 \
  -e EXA_API_KEY="$EXA_API_KEY" \
  -e KEPOS_BRIDGE_ENDPOINT="http://host.docker.internal:17480/codex/web-search" \
  ghcr.io/guionai/web:v0.1.0
```

Every operation is a versioned JSON `POST` route. Request and response schemas
are generated into `openapi.yaml` from the same route definitions:

| Route               | Request                                                                               | Purpose                                                  |
| ------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `/v1/search`        | `{ "query": "..." }`                                                                  | Kepos Bridge search with one Exa retry on Bridge failure |
| `/v1/fetch`         | `{ "url", "tree?", "section_id?", "full?", "tree_threshold?", "render?", "waitMs?" }` | Fetch Markdown                                           |
| `/v1/links`         | `{ "url", "limit?", "render?", "waitMs?" }`                                           | List page HTTP(S) links                                  |
| `/v1/docs/resolve`  | `{ "query" }`                                                                         | Resolve a Context7 library                               |
| `/v1/docs/fetch`    | `{ "library_id", "topic?", "tokens?" }`                                               | Fetch Context7 documentation                             |
| `/v1/source-search` | `{ "query", "count?", "context?", "timeout?" }`                                       | Search public source through Sourcegraph                 |
| `/v1/weather`       | `{ "location", "start?", "duration?" }`                                               | Typed Bridge weather lookup                              |
| `/v1/sports`        | `{ "fn", "league", ... }`                                                             | Typed Bridge schedule or standings lookup                |
| `/v1/finance`       | `{ "ticker", "type", "market?" }`                                                     | Typed Bridge quote or index lookup                       |
| `/v1/time`          | `{ "utc_offset" }`                                                                    | Typed Bridge time lookup                                 |

Weather, sports, finance, and time are separate Bridge-only operations; they do
not fall back to Exa and there is no generic Bridge-command route. Search keeps
a successful empty Bridge result, retries Exa exactly once for a non-cancellation
Bridge failure, and reports the provider in its response. Invalid JSON bodies,
unknown fields, and invalid typed values are rejected before an upstream call.
Upstream failures are bounded JSON errors and never include credentials or raw
provider response bodies.
Error responses use a stable `{ "code", "message", "details"? }` JSON shape;
upstream failures use 502 (or 504 for an upstream timeout), while client
cancellation is reported as 499.

Fetch and Links use direct HTTP fetching when `render` is omitted (or set to
`"fetch"`). Rendered fetching is explicit and requires both
`render: "agent-browser"` and an integer `waitMs` from 0 through 30,000; direct
fetch never silently switches backends. The container installs `agent-browser`
with Debian Chromium (including Linux ARM64, where Chrome for Testing has no
build), while credentials and Bridge configuration remain server-local
environment variables.

This is a Personal Web Service: a single-trust-boundary deployment for its
operator and agents. It is not hardened for public or multi-tenant exposure;
SSRF/egress isolation, browser sandboxing, quotas, and authentication remain
deferred in `.scratch/defered/public-http-service-security.md`.

## CLI

`web` has human-readable output by default. Add `--json` for exactly one JSON
document on stdout, which is useful for automation.

```bash
web search --provider exa -- "Node AbortSignal"
web search --provider kepos-bridge -- "Node AbortSignal"
web fetch https://example.com/article --tree
web fetch https://example.com/article --section introduction
web links https://example.com/article --limit 50
web docs resolve react
web docs fetch /facebook/react --topic hooks --tokens 2000
web sgraph --count 10 -- "repo:^github\\.com/nodejs/node$ AbortSignal"
```

Use `--` before a search or Sourcegraph query that begins with a hyphen. `fetch`
supports `--full`, `--tree`, and `--section`; long extracted documents default to
a heading tree so a later request can retrieve a stable section ID. `links` lists
up to 100 unique HTTP(S) anchors from the original page DOM.

## MCP

Run the stdio server with the same credential environment:

```bash
web mcp
# Pin search selection for the lifetime of this MCP process:
web mcp --provider brave
web mcp --provider kepos-bridge
```

The server exposes six read-only tools: `search`, `fetch`, `links`, `docs_resolve`,
`docs_fetch`, and `source_search`. Its stdout is reserved for MCP protocol
messages; diagnostics go to stderr. For a client-rendered page, explicitly call
`fetch` or `links` with `render: "agent-browser"` and an integer `waitMs`; this optional
retry requires a host-installed executable and never happens automatically.

## Pi

Install the independently bundled Pi extension:

```bash
pi install npm:@guionai/pi-web
```

It registers `web_search`, `web_fetch`, `web_links`, `web_docs`, and `web_source_search` and calls
the bundled core in-process. Pi and TypeBox are peer dependencies supplied by
the host; no CLI executable or MCP configuration is required. `web_fetch` uses
direct fetch by default and can explicitly use `render: "agent-browser"` with
an integer `waitMs` when its host provides that optional executable.
`web_links` uses the same explicit rendering contract and lists HTTP(S) anchors
from the original page DOM.

Set `WEB_SEARCH_PROVIDER=kepos-bridge` before starting Pi to select the
credential-free Kepos Bridge provider. Pi uses the bundled default Bridge route;
only DSH exposes a route setting.

## DSH

Install the DSH bundle in the existing Web profile:

```bash
dsh plugin --profile web add @guionai/dsh-web
```

The included profile patch routes stock PTC web search through the selected Exa,
Brave, or Kepos Bridge provider. Its settings UI stores provider selection and
the complete non-secret Kepos Bridge route (default
`http://codex-bridge.localhost:17480/codex/web-search`) and manages namespaced write-only
credentials. Selecting Kepos Bridge additionally exposes `web_weather`,
`web_sports`, `web_finance`, and `web_time`; these tools are removed when another
provider is selected. Fetch, link discovery, documentation, and Sourcegraph tools
also run in-process. The host DSH packages and React are peers supplied by DSH.
`web_fetch` uses direct fetch by default and can explicitly use
`render: "agent-browser"` with an integer `waitMs` on a host that supplies the
optional executable.
`web_links` uses the same explicit rendering contract and lists HTTP(S) anchors
from the original page DOM.

## Page-fetch backends

`web fetch` has two backends. `fetch` (the default) uses Node `fetch`,
`linkedom`, and Defuddle for direct HTML-to-Markdown extraction from static,
SSR, and pre-rendered pages. `agent-browser` renders client-side pages through
a separately installed host executable. Direct fetch is used by default; choose
agent-browser explicitly when needed. The implementation never falls back
automatically:

```bash
web fetch https://example.com/app --render=agent-browser --wait=2000
# If it is still incomplete, retry explicitly with more time, or abandon it:
web fetch https://example.com/app --render=agent-browser --wait=10000
```

`web links` uses the same direct or explicit browser-rendered source, but parses
the original DOM rather than Defuddle output so navigation and other links outside
the readable article remain discoverable. It returns only HTTP(S) `a[href]`
destinations, deduplicated and capped at 100 by default.

`--wait` is mandatory with `--render=agent-browser`, including `--wait=0`, and
accepts only an integer from 0 through 30,000 milliseconds. Direct `fetch`
or `links` requests must not provide `--wait`. The same `render: "agent-browser"` and required
`waitMs` fields are available on the MCP `fetch`/`links`, Pi `web_fetch`/`web_links`, and DSH
`web_fetch`/`web_links` tools. A direct-fetch failure may return the structured
`javascript_rendering_may_be_required` hint with the 2,000 ms suggestion; the
agent decides whether to retry with a longer wait or abandon the page.

Rendering is an optional host capability. If you choose to use it, install
[agent-browser](https://github.com/vercel-labs/agent-browser) separately on the
host:

```bash
npm install --global agent-browser
agent-browser install
```

`agent-browser install` manages its own browser runtime; Guion packages never
run it, bundle it, or reuse browser credentials. A compatible executable must be
directly runnable from `PATH` without a shell. The renderer is supported on
macOS and Linux hosts. Direct fetch remains available, and the three npm
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
```

`test:release` uses disposable manifests to exercise tag-version
synchronization. `test:pack` runs each public package's packed installation or
host-loading contract in test-owned temporary directories.

## Releases

A `v<semver>` tag is the release source of truth for all three public packages:
`@guionai/web`, `@guionai/pi-web`, and `@guionai/dsh-web`. The release preflight
synchronizes its checkout manifests from that tag, then completes formatting,
typechecking, build, tests, release-version checks, and packed smoke tests
before any publication begins.

Three independent, non-fail-fast protected `npm` Environment matrix cells then
publish one package each through npm Trusted Publishing with provenance. The
synchronized version selects npm's `latest` tag for stable SemVer and `beta` for
a prerelease. A matching immutable-tagged image is published to
`ghcr.io/guionai/web:<tag>` with the `web serve` entrypoint and the
`agent-browser` runtime. After all three npm cells and the image job succeed,
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
