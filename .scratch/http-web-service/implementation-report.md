# Guion Web page-reading contract implementation report

## Scope

- Repository: `guionai/web`
- Branch: `http-web-service`
- Fixed point: `9fff0766001f5ebcad91045c34958af72841da09`
- Implementation commits: `bb4900a5dba9b5d71fdd64363ce860953b2dc098` (`feat(http): unify page-reading contract`) and `90de2fa9d77a6dc2ac8c34284f469e1d722e3d12` (`fix(http): repair navigation and renderer validation`)
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
- H1-only long documents now list their H1 as a selectable tree node with a
  stable `section_id`; a Core behavior test retrieves the emitted ID and checks
  the complete section content.

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
- CONTEXT.md now uses the public `render: "http" | "browser"` vocabulary for
  glossary and HTTP guidance; `agent-browser` appears only as an operator
  implementation/setup detail. Pi and DSH each consolidate their repeated
  renderer/wait checks in one local helper while preserving validation order,
  messages, and forwarding behavior.

## Review-fix batch

The post-review repairs were applied together in `90de2fa`:

- Core tree output for an H1-only long document emits its deterministic heading
  ID, and the behavior test uses that ID to retrieve the section.
- CONTEXT.md describes the public HTTP/browser renderer contract and reserves
  the `agent-browser` name for operator implementation/setup wording.
- Pi and DSH each own a local `validateRenderOptions` helper; no
  cross-adapter abstraction was added.

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

The review-fix commit was additionally verified with:

- `pnpm typecheck`.
- `pnpm format:check` and explicit Prettier checks for the changed source files,
  CONTEXT.md, and the HTTP reference.
- `pnpm test` — 19 test files and 118 tests passed. The existing DSH source-map
  warning was non-fatal.
- `pnpm build` — all workspace packages built and generated
  `packages/web/dist/openapi.yaml`.
- `pnpm test:release` — release version synchronization fixtures passed.
- `pnpm test:pack` — packed-installation/host-loading checks passed for
  `@guionai/web`, `@guionai/pi-web`, and `@guionai/dsh-web`.

## Changed paths and size

Against the fixed point, excluding generated `dist` output, lockfiles, and
this report:

- Product code: 324 additions and 254 deletions (578 changed lines) across
  Core, CLI, MCP, Pi, DSH, and HTTP.
- Tests: 218 additions and 166 deletions (384 changed lines), including Core
  navigation/renderer seams, adapter forwarding/validation, and OpenAPI
  artifact parsing.
- Documentation/configuration: 226 additions and 53 deletions (279 changed
  lines), including the 154-line standalone HTTP reference and aligned README,
  ADR, package metadata, and DSH guide.
- Total: 768 additions and 473 deletions (1,241 changed lines), within the
  spec estimate of 780–1,400 total changed lines. Product code is modestly
  above its 250–450 estimate because each owned adapter now performs explicit
  input normalization and legacy-field rejection at its boundary; the review
  repair remains a small local delta.

## Remaining concerns

- Public or multi-tenant HTTP hardening remains out of scope as documented by
  ADR 0001 and the existing deferred security note.
- Code review and deployment were intentionally not run for this implementation
  task.
