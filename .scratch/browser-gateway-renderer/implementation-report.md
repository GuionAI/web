# Browser gateway renderer implementation report

## Result

The whole `browser-gateway-renderer` spec and its only ticket are implemented
on the `browser-gateway-renderer` branch. The containerized HTTP Service now
delegates explicit browser rendering to the server-local Browser Rendering
Gateway (`POST /api/render`), while Web Core continues to own HTML extraction,
navigation, links, and content limits. CLI, MCP, Pi, and DSH keep the existing
direct `agent-browser` renderer.

## Acceptance criteria

- [x] Configured gateway Fetch and Links requests send `{ url, waitMs }`, use
  returned raw DOM and final URL, preserve navigation/link response contracts,
  and accept `waitMs` from 0 through 30,000.
- [x] Missing, overloaded, unreachable, timed-out, malformed, oversized, or
  failed gateway work is translated to explicit `render_*` capability errors;
  cancellation propagates and HTTP rendering remains independent.
- [x] The production image uses the slim Node runtime without Chromium or
  `agent-browser`; direct browser users outside the HTTP image retain their
  existing capability.
- [x] README, HTTP-service/operator documentation, glossary, Dockerfile
  comments, release documentation, and ADRs describe the gateway boundary and
  `BROWSER_GATEWAY_URL` configuration.
- [x] Tests cover the fetch transport seam, HTTP routes, failure/cancellation
  behavior, and the image contract without a live browser, cluster,
  credentials, or production service.

## Verification

All checks completed successfully from the final implementation:

- `pnpm typecheck`
- `pnpm build`
- `pnpm test` — 20 files, 152 tests passed
- `pnpm test:release`
- `pnpm test:pack` — web, Pi, and DSH package smoke checks passed
- `pnpm format:check`
- `git diff --check`
- `docker build --tag guionai-web:browser-gateway-test .`
- Test-owned gateway plus image smoke request — HTTP Fetch returned rendered
  content and the gateway log confirmed `/api/render` with `{ url, waitMs }`.
- Runtime binary probe — `no-browser-binaries` for `agent-browser`, Chromium,
  and Google Chrome.

## Fixed-point LOC accounting

The fixed point is `ed74871`. Generated files and lockfiles are excluded.
Actual additions and deletions are:

| Category | Additions | Deletions |
| --- | ---: | ---: |
| Product code | 341 | 9 |
| Tests | 356 | 0 |
| Configuration and docs | 91 | 34 |
| **Total** | **788** | **43** |

The total (831 changed lines) is within the spec estimate of 570–960. Product
code and test additions are near the upper half because the gateway boundary
includes bounded transport, response validation, cancellation, timeout/error
translation, and HTTP plus package-level seams; no compatibility layer or
unfinished infrastructure was added.

## Commits and scope

- `9c9a088 feat(http): delegate container browser rendering to gateway`
- Changed implementation paths: `packages/web-core/src/`,
  `packages/web-core/test/`, `packages/web/src/http.ts`,
  `packages/web/src/program.ts`, `Dockerfile`, `README.md`, `CONTEXT.md`,
  `docs/http-service.md`, and `docs/adr/`.

The required report is intentionally kept under `.scratch` and is excluded
from the implementation LOC table above.

## Remaining operational boundary

The separately deployed Browser Rendering Gateway must be reachable and
configured through `BROWSER_GATEWAY_URL`; its deployment, capacity, proxy,
authentication, and rollout remain outside this repository. Code review and
deployment are excluded from this implementation task.
