# DeepSeek search provider implementation report

## Scope

- Repository: `guionai/web`
- Branch: `deepseek-search-provider`
- Fixed point: `987f664b1d43d2b3325849a8ed818c7332bf8808`
- Implementation commit: `6826d3ead70eafaca21965b125041dc95ef63a7a` (`feat(search): add explicit DeepSeek provider`)
- Delivery boundary: the complete `deepseek-search-provider` spec and tickets
  01, 02, and 03. Code review and deployment were excluded.

The tickets were implemented in dependency order: the shared Core adapter and
selection seam first, then CLI/MCP/Pi and DSH, followed by the server-local
HTTP selection and OpenAPI contract.

## Review repair batch

- Repair commit: `e7ef2fc` (`fix(search): tighten DeepSeek review contracts`).
- The review-again gate classified these as local contract/test repairs: the
  runtime method and risk surface are unchanged, so focused verification was
  sufficient and a second broad code review was not required.
- Removed the three DeepSeek packed-artifact source-string assertions from the
  artifact test. Existing runtime, provider, and rendered-settings tests remain
  the behavior coverage for those contracts.
- DeepSeek's seven endpoint/model/version/token/tool protocol constants are now
  implementation-private in web-core. The Core fixture asserts the expected
  protocol through test-local constants instead of importing production
  implementation details.
- DSH alpha.3 deployed-entrypoint acceptance was unavailable on this host. The
  documented path `/home/neil/.local/share/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`
  failed the availability check (`test -f` returned `unavailable`), and the
  direct probe `node --expose-internals /home/neil/.local/share/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js --help`
  failed with `MODULE_NOT_FOUND`. Consequently, no Host/browser acceptance was
  run, and no host state or credentials were created or modified.

## Ticket outcomes

### 01 — Add explicit DeepSeek search outside DSH

- Core recognizes `deepseek` only when explicitly selected and requires
  `DEEPSEEK_API_KEY`; Exa/Brave implicit selection remains unchanged, so a
  DeepSeek key alone never changes the default.
- The adapter posts one fixed Anthropic-compatible Messages request to
  `https://api.deepseek.com/anthropic/v1/messages` using
  `deepseek-v4-flash`, `max_tokens: 4096`, the fixed auxiliary search prompt,
  and `web_search_20250305` with `max_uses: 5`. The endpoint/model/tool details
  are not host request fields.
- Only structured `web_search_tool_result` / `web_search_result` blocks are
  mapped. URL-keyed `cited_text` excerpts become snippets, duplicate URLs are
  removed, and prose-only responses are provider errors. Requests use the
  existing bounded timeout/cancellation and secret-safe response handling.
- CLI and MCP flags, Pi's existing provider environment mechanism, runtime
  credentials, and MCP error redaction recognize DeepSeek. Their search inputs
  remain provider-neutral where applicable.
- README and host documentation describe explicit selection, normalized
  results, and the one auxiliary model-call cost.

### 02 — Add DeepSeek to DSH provider settings

- DSH's live provider union/picker includes `deepseek` and its label.
- The settings client manages the namespaced write-only
  `GUIONAI_DSH_WEB_DEEPSEEK_API_KEY` credential alongside Exa and Brave. The
  UI has no DeepSeek endpoint field; the existing endpoint control remains
  explicitly a Kepos Bridge setting.
- The host adapter resolves only the selected DeepSeek credential for each
  operation and forwards `provider: "deepseek"` through Core. Kepos-only tool
  registration and non-DeepSeek provider behavior remain unchanged.
- DSH host, browser-client, packed-artifact, settings, and provider-fake tests
  cover selection, DeepSeek metadata-only status, the existing write/remove
  flow, and artifact presence without live credentials.
- The DSH README and package metadata document the picker/key workflow, no
  DeepSeek endpoint input, normalized results, and call cost.

### 03 — Select DeepSeek for the personal HTTP service

- With no `WEB_SEARCH_PROVIDER`, HTTP retains its Bridge-first policy and one
  Exa retry, including the existing Exa startup requirement.
- With server-local `WEB_SEARCH_PROVIDER=deepseek`, startup requires a
  non-empty `DEEPSEEK_API_KEY`; each request calls DeepSeek exactly once and
  never falls back to Bridge or Exa. HTTP clients still send only
  `{ "query": "..." }`.
- HTTP validation and generated OpenAPI include the `DeepSeek` response label
  without adding a request provider field. Fakes cover selected success,
  failure/no-fallback, startup key validation, cancellation treatment, and
  unchanged default behavior.
- The HTTP reference, README, glossary, and ADR document the server-local
  selection, credential boundary, normalized contract, and no-fallback rule.

## Verification

All implementation and review-repair checks completed successfully:

- Focused `pnpm exec vitest run packages/web-core/test/search.test.ts
  packages/dsh-web/test/artifact.test.ts` — 2 files and 14 tests passed.

- `pnpm format:check` and explicit Prettier checks for the changed Markdown
  references; `git diff --check`.
- `pnpm typecheck`.
- `pnpm test` — 19 test files and 132 tests passed. The existing missing DSH
  primitive source-map warning was non-fatal.
- `pnpm build` — all four workspace packages built and generated
  `packages/web/dist/openapi.yaml` with the DeepSeek response enum.
- `pnpm test:release` — release version synchronization fixtures passed.
- `pnpm test:pack` — packed-installation/host-loading checks passed for
  `@guionai/web`, `@guionai/pi-web`, and `@guionai/dsh-web`.

No live DeepSeek service, credentials, production services, or persistent host
state were used.

## Changed paths and size

Against the fixed point, excluding generated `dist` output, lockfiles, and
this report:

- Product code: 209 additions and 12 deletions (221 changed lines) across
  Core, CLI, MCP, Pi, DSH, and HTTP.
- Tests: 372 additions and 2 deletions (374 changed lines), including Core
  request/mapping/error seams, adapter forwarding, DSH credential/UI checks,
  HTTP selection, and OpenAPI assertions.
- Documentation/configuration: 71 additions and 37 deletions (108 changed
  lines), including README, HTTP reference, glossary, ADR, DSH README, and
  package metadata.
- Total: 652 additions and 51 deletions (703 changed lines), within the spec's
  580–970 total-line estimate. Product code is below its 260–410 estimate
  because the implementation reuses the existing bounded-request, normalized
  result, host-selection, settings, and artifact seams; the tests and
  documentation remain within their estimated ranges.

## Remaining concerns

- A live DeepSeek capability/account probe remains intentionally deferred by
  the spec; tests use injected local fetch fixtures only.
- Public or multi-tenant HTTP hardening remains out of scope as documented by
  ADR 0001 and the existing deferred security note.
- A second broad code review and deployment were intentionally not run; the
  review-again gate classified this batch as local repairs.

## Acceptance result

Tickets 01, 02, and 03 and the complete `deepseek-search-provider` spec are
implemented and verified.
