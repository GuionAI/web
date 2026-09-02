# Public HTTP service hardening

Before Guion Web's container is presented as a public or multi-tenant service, define and implement the security boundary for outbound requests and rendered browsing. The current first release is a Personal Web Service only.

Required decisions and work:

- Block private, loopback, link-local, and otherwise non-public network targets across redirects and DNS resolution, including DNS rebinding.
- Run `agent-browser` in an isolated browser/process and restrict its network egress consistently with direct fetch.
- Set resource and concurrency limits appropriate for a remotely reachable renderer.
- Define the authentication and tenant boundary when the service stops being personal.

This deferred work does not change the v1 search policy: the Personal Web
Service tries the server-configured Bridge Route first, preserves successful
empty results, and falls back exactly once to the server-configured Exa
credential only for a non-cancellation Bridge failure. Typed Bridge Data
Operations report Bridge failure directly.
