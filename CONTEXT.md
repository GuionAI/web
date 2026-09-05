# Guion Web

Guion Web provides read-only research operations through local integrations and a self-hosted HTTP service. This glossary keeps the interfaces and their deployment boundary distinct.

## Language

**Personal Web Service**:
A self-hosted, single-trust-boundary deployment of Guion Web for its operator and their agents. It is not a public or multi-tenant hosted service.
_Avoid_: Public service, SaaS

**Research Operation**:
One of Guion Web's read-only capabilities: Search, Fetch, Links, Documentation Resolve or Fetch, or Public-source Search. It is independent of the transport that exposes it.
_Avoid_: Tool, endpoint

**Search**:
The general web-retrieval Research Operation. CLI, MCP, Pi, and DSH can
explicitly select Exa, Brave, DeepSeek, or Kepos Bridge. In the Personal Web
Service, it uses Kepos Bridge first and transparently falls back to Exa only
when the Bridge is unavailable unless the operator sets
`WEB_SEARCH_PROVIDER=deepseek`; that server-local mode calls DeepSeek only and
has no fallback. Its response identifies the provider that supplied results.
_Avoid_: Bridge search, HTTP provider parameter

**Bridge Data Operation**:
A typed, Bridge-only lookup for weather, sports, finance, or time. It has no Exa fallback because Exa search is not an equivalent result source.
_Avoid_: Generic Bridge command, special search

**Bridge Route**:
The server-local URL used by the Kepos Bridge search provider. The service operator configures it; API callers never supply it.
_Avoid_: Bridge URL parameter

**Page Rendering**:
Fetch and Links use `render: "http"` by default or explicit `render: "browser"`.
Browser rendering requires `waitMs` from 0 through 30,000 and is never selected
automatically. The containerized HTTP Service delegates browser requests to the
server-local Browser Rendering Gateway; CLI, MCP, Pi, and DSH retain the
operator-installed `agent-browser` capability. Both are implementation and setup
details, not adapter-facing request values.
_Avoid_: Backend-specific renderer labels, automatic fallback

**Page Navigation**:
The shared page-reading module owns its fixed 5,000-character policy. A long,
unsectioned request with navigable headings returns a navigation tree; a
headingless long document uses the normal bounded automatic response. The
request `mode` is `auto` by default and may be `full` or `tree`; `section_id`
is allowed with omitted or `auto` mode and retrieves one section. Full and tree
reject `section_id`, and input mode `section` is removed. Ordinary automatic
document results report `mode: "auto"`; full, tree, and section results report
their corresponding modes. Every Fetch result includes `truncated`, which is
true only when automatic content was cut by the content-length limit.
_Avoid_: Caller-selected tree thresholds, legacy navigation booleans

**Release Contract**:
The versioned public distribution of Guion Web: its npm packages, GHCR container image, and the generated `openapi.yaml` attached to the matching GitHub Release.
_Avoid_: Checked-in OpenAPI file, independently versioned schema

**HTTP Service**:
The Hono-based `/api/v1/web` JSON API shipped by `web serve` and the GHCR image. It
uses server-local credentials, Bridge Route, and optional DeepSeek provider
configuration; clients do not select providers or submit a generic Bridge
command. Its page-reading routes use
the same `render: "http" | "browser"`, `mode`, and `section_id` contract. The
GHCR image sets `GUIONAI_HTTP_IMAGE=1` and delegates browser rendering to the
server-local Browser Rendering Gateway configured by the operator; a local/npm
server with direct operations retains its direct browser capability. The
browser executable name appears only in gateway-side setup for the image.
_Avoid_: Remote MCP, public service

**Gateway Web API prefix**:
The `/api/v1/web` versioned path namespace for the HTTP Service's research
operations when exposed through FlickNote Gateway. It identifies Guion Web as
the owning service without changing its operation contracts.
_Avoid_: Bare `/v1` API, generic web route

**DSH Research Surface**:
The Guion-owned model-facing DSH tool suite: `web_search`, `web_fetch`,
`web_links`, `web_docs`, and `web_source_search`, plus `web_weather`,
`web_sports`, `web_finance`, and `web_time` while Kepos Bridge is selected.
It is registered globally by `@guionai/dsh-web`; native and PTC presentation
modes consume the same registrations.
_Avoid_: Official Web suite, scoped Web row

**Compatible DSH Preset**:
A DSH preset that omits its entire scoped `tool-web` row and therefore inherits
the global DSH Research Surface from Guion. The `web dsh sync` command creates
four generated compatible copies with the same ids as the official shipped
`standard`, `ptc`, `cordis`, and `minimal` presets. The DSH bundle hides the
shipped root while retaining the user root, so these copies become active and
ordinary user presets such as Yuki remain visible.
_Avoid_: Unmanaged copied preset, partially compatible preset

**Official Shipped DSH Preset**:
A preset installed by `@deepseek-ai/dsh-agent-presets` beside the DSH runtime.
It is deployment-owned, may include the scoped official `tool-web` row, and is
never edited by Guion. The bundle sets `includeShippedRoot: false` because DSH
shipped entries win same-id duplicates.
_Avoid_: Managed preset, user preset

**Guion-Compatible DSH Preset**:
A full snapshot under `${DSH_HOME:-$HOME/.dsh}/.agent-presets` generated by
`web dsh sync` from the installed official rc.1 package. Sync recognizes it by
comparing its complete contents with the expected transformed official tree;
no ownership marker is stored. A different same-id directory requires explicit
interactive confirmation or `--yes`. `web dsh doctor` verifies that all four
snapshots are current, complete, and free of scoped `tool-web` rows.
_Avoid_: Hand-edited output, shipped preset

**Ordinary DSH User Preset**:
A user-created directory in the DSH user preset root. It remains visible when
the bundle hides the shipped root. A same-id preset is overwritten only after
interactive confirmation or an explicit `web dsh sync --yes`.
_Avoid_: Generated compatible preset, shipped preset
