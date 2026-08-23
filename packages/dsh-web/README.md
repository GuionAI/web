# @guionai/dsh-web

DeepSeek Harness rc.8 Web bundle and browser settings client for Guion Web.

Install it into the existing Web profile:

```bash
dsh plugin --profile web add @guionai/dsh-web
```

The package owns the Web profile patch and does not require a custom profile or
PTC preset. It leaves the root `tool-web` row disabled and routes stock PTC's
batched `web_search` through the Guion provider seam.

Provider selection is explicit and persists in the `guionai-web` settings
namespace. Exa and Brave API keys use namespaced write-only DSH credentials;
settings expose only configured/source/writable metadata.

The published package is a dual host/browser bundle. Its host and client
artifacts, profile patch, and exact DSH `0.1.0-rc.8` peer contract are included
in the npm package. Search, browserless page fetch, Context7 documentation,
and Sourcegraph all run in-process through the bundled Guion Web core.
`web_fetch` remains browserless by default; an agent may explicitly request
`render: "agent-browser"` with a required integer `waitMs` from 0 through
30,000 to render a client-side page through a host-installed `agent-browser`
executable. The optional renderer is supported on macOS and Linux, is not an
npm dependency, and never reuses persistent browser state or credentials.

Rendered requests are bounded and constrained to the requested host, its
subdomains, and these common CDNs: `cdn.jsdelivr.net`, `unpkg.com`,
`cdnjs.cloudflare.com`, `ajax.googleapis.com`, `fonts.googleapis.com`,
`fonts.gstatic.com`, and `esm.sh`. For example, retry a shell with
`render: "agent-browser", waitMs: 2000`, then explicitly retry with a longer
wait such as `waitMs: 10000` or abandon the page. A blocked dependency returns
`render_domain_not_allowed` with
https://github.com/guionai/web/issues/new for reporting a likely allowlist
gap; increasing `waitMs` will not help that failure. Host-level DNS rebinding
and egress isolation remain deployment responsibilities, so this backend is
not a complete SSRF boundary for arbitrary untrusted URLs.
