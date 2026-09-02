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
automatically. The operator-installed `agent-browser` runtime is an implementation
and setup detail, not an adapter-facing request value.
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
The Hono-based `/v1` JSON API shipped by `web serve` and the GHCR image. It
uses server-local credentials, Bridge Route, and optional DeepSeek provider
configuration; clients do not select providers or submit a generic Bridge
command. Its page-reading routes use
the same `render: "http" | "browser"`, `mode`, and `section_id` contract; the
browser executable name appears only in operator setup.
_Avoid_: Remote MCP, public service
