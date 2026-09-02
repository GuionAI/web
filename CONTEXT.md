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
The general web-retrieval Research Operation. In the Personal Web Service, it uses Kepos Bridge first and transparently falls back to Exa only when the Bridge is unavailable; its response identifies the provider that supplied results.
_Avoid_: Bridge search, provider-selected search

**Bridge Data Operation**:
A typed, Bridge-only lookup for weather, sports, finance, or time. It has no Exa fallback because Exa search is not an equivalent result source.
_Avoid_: Generic Bridge command, special search

**Bridge Route**:
The server-local URL used by the Kepos Bridge search provider. The service operator configures it; API callers never supply it.
_Avoid_: Bridge URL parameter

**Rendered Fetch**:
A fetch performed with the host-installed `agent-browser` browser runtime, explicitly selected instead of direct HTTP fetching.
_Avoid_: Browser fetch, automatic fallback

**Release Contract**:
The versioned public distribution of Guion Web: its npm packages, GHCR container image, and the generated `openapi.yaml` attached to the matching GitHub Release.
_Avoid_: Checked-in OpenAPI file, independently versioned schema

**HTTP Service**:
The Hono-based `/v1` JSON API shipped by `web serve` and the GHCR image. It
uses server-local credentials and Bridge Route configuration; clients do not
select providers or submit a generic Bridge command.
_Avoid_: Remote MCP, public service
