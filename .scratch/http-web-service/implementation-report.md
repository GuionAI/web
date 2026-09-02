# Guion Web HTTP service implementation report

## Scope

- Repository: `guionai/web`
- Branch: `http-web-service`
- Fixed point: `ebad44eb55f8a406b855318cb8a4b4cd04633227`
- Implementation commit: `3316d5bb5e14e81d89dbdd84239d16b5de007b10` (`feat(http): add personal research service`)
- Delivery boundary: the complete HTTP-service spec and tickets 01, 02, and 03; code review and deployment were excluded.

The implementation was completed in dependency order: the server-local Bridge-first Search and typed Bridge Data Operations, the remaining Research Operations and container guide, and then the release/OpenAPI/GHCR contract.

## Ticket outcomes

### 01 — Serve Search and Bridge Data over HTTP

- Added `web serve` with Hono and `@hono/zod-openapi` route schemas.
- Added `/v1/search`, `/v1/weather`, `/v1/sports`, `/v1/finance`, and `/v1/time`.
- HTTP Search sends server-local Kepos Bridge configuration first, preserves a successful empty result, retries Exa exactly once for a non-cancellation Bridge failure, and does not retry cancellation.
- Startup requires a non-empty `EXA_API_KEY`; `KEPOS_BRIDGE_ENDPOINT` is validated and otherwise uses the core default. Context7 remains optional.
- Typed Data Operations accept only their documented fields, call only their corresponding Bridge command, and have no generic command or Exa fallback.
- Invalid bodies, malformed JSON, capability failures, timeouts, cancellations, and upstream failures map to bounded documented JSON error responses without credentials or raw upstream bodies.

### 02 — Complete the Research API and Container Guide

- Added `/v1/fetch`, `/v1/links`, `/v1/docs/resolve`, `/v1/docs/fetch`, and `/v1/source-search` with request and response schemas.
- Fetch and Links default to direct fetching; rendered fetching requires explicit `render: "agent-browser"` and an integer `waitMs` from 0 through 30,000.
- Added the Node 24 container image, installing the pinned `agent-browser` runtime and starting `web serve` on port 8787. Credentials and Bridge configuration remain environment-only.
- Updated `README.md`, `CONTEXT.md`, ADR 0001, and `.scratch/defered/public-http-service-security.md` to describe the personal-service boundary and deferred public hardening.

### 03 — Publish the Versioned HTTP Service Contract

- The web build now generates `packages/web/dist/openapi.yaml` from the registered route schemas with the package version.
- The release preflight uploads the generated contract; the release workflow publishes a release-tagged GHCR image with `packages: write` and creates the GitHub Release only after npm and image jobs succeed.
- The matching generated `openapi.yaml` is attached to the GitHub Release and is not checked in or independently versioned.

## Verification

All checks below completed successfully against the implementation commit:

- `pnpm format:check` — all files matched Prettier.
- `pnpm typecheck` — TypeScript completed with no errors.
- `pnpm build` — all workspace packages built; `packages/web/dist/openapi.yaml` generated.
- Generated OpenAPI parse check — OpenAPI `3.1.0`, package version `0.1.0`, exactly the 10 documented `/v1` paths, and no generic Bridge route.
- `pnpm test` — 18 test files and 109 tests passed. The existing DSH source-map warning was non-fatal.
- `pnpm test:release` — release version synchronization fixtures passed.
- `pnpm test:pack` — packed-installation/host-loading smoke tests passed for `@guionai/web`, `@guionai/pi-web`, and `@guionai/dsh-web`.
- Focused in-process HTTP tests use injected operation fakes and test-owned credentials; they cover validation, exact fallback/cancellation behavior, typed Bridge command shapes, response normalization, startup configuration, and OpenAPI paths without provider or browser network calls.

The local Docker daemon was unavailable for a Docker build check (`/Users/neil/.orbstack/run/docker.sock` did not exist). The Dockerfile and workflow were reviewed statically; image deployment remains outside this task's boundary.

## Changed paths and size

Against the fixed point, excluding generated `dist` output (including `openapi.yaml`) and `pnpm-lock.yaml`:

- Product code: 932 additions, 1 deletion (`packages/web/src`, `packages/web-core/src`).
- Tests: 385 additions (`packages/web/test`, `packages/web-core/test`).
- Configuration and documentation: 240 additions, 14 deletions (Docker, release workflow, manifests, README, CONTEXT, ADR, and deferred note).
- Total: 1,557 additions and 15 deletions (net 1,542 lines).

The total is within the spec estimate of 1,230–1,900 lines. The focused HTTP suite is 385 lines, just below the 400-line test estimate because route behavior is consolidated in one in-process fixture file rather than duplicated across transport tests.
