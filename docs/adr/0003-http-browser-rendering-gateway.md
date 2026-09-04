# Delegate HTTP browser rendering to the Browser Rendering Gateway

## Status

Accepted

## Context

The GHCR image previously installed Chromium and `agent-browser` so each
explicit `render: "browser"` request could start a private browser process.
The apps-dev deployment already operates a persistent Browser Rendering
Gateway with the proxy, anti-bot, and capacity controls needed for browser
work. Maintaining a second browser runtime in the HTTP-service image adds
startup, memory, and lifecycle cost.

## Decision

Only the containerized HTTP Service delegates explicit browser rendering to
the server-local Browser Rendering Gateway. It sends `POST /api/render` with
`{ "url", "waitMs" }` and receives raw rendered `{ "html", "url" }`. The
existing Web Core then performs target validation, extraction, navigation, and
link handling, so Fetch and Links keep their public contracts. `waitMs` remains
caller-visible and is required from 0 through 30,000; browser rendering never
falls back to HTTP.

`BROWSER_GATEWAY_URL` is server-local configuration. Missing configuration,
gateway overload, transport failure, timeout, or malformed output becomes an
explicit `render_*` capability failure. HTTP rendering remains independent.

CLI, MCP, Pi, and DSH continue to use the shared Web Core's direct
`agent-browser` capability. The GHCR image therefore contains neither
Chromium nor `agent-browser`; the gateway owns that runtime and its deployment
boundary.

## Consequences

The HTTP-service image is smaller and does not launch a local browser. Browser
requests require the in-cluster gateway to be reachable, and operators must
configure `BROWSER_GATEWAY_URL` before using them. Gateway deployment,
capacity, authentication, and rollout remain outside this repository and are
owned by the separate browser-gateway service.
