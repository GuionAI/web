# Guion Web page-reading contract implementation report

## Scope

- Repository: `guionai/web`
- Branch: `http-web-service`
- Fixed point: `9fff0766001f5ebcad91045c34958af72841da09`
- Implementation commit: `bb4900a5dba9b5d71fdd64363ce860953b2dc098` (`feat(http): unify page-reading contract`)
- Delivery boundary: the complete `http-web-service` spec and tickets 01 and 02.
  Code review and deployment were excluded.

The tickets were implemented in dependency order: the shared Core page-reading
seam first, then every adapter, HTTP/OpenAPI contract, tests, and documentation.

## Ticket outcomes

### 01 — Unify the page-reading module interface

- Core Fetch and Links now accept only `render: "http" | "browser"`.
  HTTP is the default; browser requires `waitMs` from 0 through 30,000, while
  HTTP forbids `waitMs`. Capability errors suggest `render: "browser"` with
  `waitMs: 2000`.
- Public `tree` and `tree_threshold` inputs were removed. The module owns the
  fixed 5,000-character policy: non-full, unsectioned long content returns a
  navigation tree, `full: true` returns complete extracted Markdown without the
  Core 30,000-character truncation, and `section_id` retrieves one tree section.
- `full: true` with `section_id` is rejected. Core validation also rejects
  unknown legacy fields and invalid navigation values.
- Core tests use injected cache, HTTP, and browser seams; no live provider or
  browser state is required.

### 02 — Align adapters, HTTP, and reference documentation

- CLI flags/help, stdio MCP schemas, Pi TypeBox schemas/prompts, DSH tool
  definitions, and HTTP schemas now expose the same renderer and navigation
  vocabulary without compatibility aliases.
- HTTP remains exactly `/v1/search`, `/v1/fetch`, and `/v1/links`. Search keeps
  server-selected Kepos Bridge-first behavior with one Exa retry; Fetch and
  Links enforce the shared renderer rules.
- The build generates the version-matched OpenAPI 3.1 artifact at
  `packages/web/dist/openapi.yaml`; the release artifact test parses a
  test-owned generated file and asserts exactly the three retained routes and
  the unified request schemas.
- Added [`docs/http-service.md`](../../docs/http-service.md), a standalone
  human-readable reference covering requests, responses, validation, provider
  behavior, renderer behavior, errors, and the OpenAPI release asset. README
  and ADR 0001 link to and describe the same contract. Operator setup may still
  name the installed browser executable.

## Verification

All checks completed successfully against the implementation commit:

- `pnpm format:check` and explicit Prettier checks for the ADR, DSH README, and
  standalone HTTP reference.
- `pnpm typecheck`.
- `pnpm test` — 19 test files and 117 tests passed. The existing DSH source-map
  warning was non-fatal.
- `pnpm build` — all workspace packages built and generated
  `packages/web/dist/openapi.yaml`.
- `pnpm test:release` — release version synchronization fixtures passed.
- `pnpm test:pack` — packed-installation/host-loading checks passed for
  `@guionai/web`, `@guionai/pi-web`, and `@guionai/dsh-web`.
- Docker validation with the supported image: `docker build --tag
guionai-web-http-smoke .` passed; a disposable container returned HTTP 400
  for invalid Fetch input and HTTP 200 for a real browser-rendered
  `https://example.com` Fetch with `full: true`.

No live credentials were used. The Docker smoke used a disposable container
and a non-secret placeholder startup key; it was stopped after verification.

## Changed paths and size

Against the fixed point, excluding generated `dist` output, lockfiles, and
this report:

- Product code: 290 additions and 210 deletions (500 changed lines) across
  Core, CLI, MCP, Pi, DSH, and HTTP.
- Tests: 203 additions and 194 deletions (397 changed lines), including Core
  navigation/renderer seams, adapter forwarding/validation, and OpenAPI
  artifact parsing.
- Documentation/configuration: 210 additions and 49 deletions (259 changed
  lines), including the 154-line standalone HTTP reference and aligned README,
  ADR, package metadata, and DSH guide.
- Total: 703 additions and 425 deletions (1,128 changed lines), within the
  spec estimate of 780–1,400 total changed lines. Product code is modestly
  above its 250–450 estimate because each owned adapter now performs explicit
  input normalization and legacy-field rejection at its boundary.

## Remaining concerns

- Public or multi-tenant HTTP hardening remains out of scope as documented by
  ADR 0001 and the existing deferred security note.
- Code review and deployment were intentionally not run for this implementation
  task.
