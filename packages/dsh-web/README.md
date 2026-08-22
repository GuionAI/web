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
in the npm package. Search, page fetch, Context7 documentation, and
Sourcegraph all run in-process through the bundled Guion Web core; no native
binary, subprocess, or global environment credential is used.
