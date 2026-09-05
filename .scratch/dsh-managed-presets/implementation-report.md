# DSH managed presets implementation report

## Scope

- Repository: `guionai/web`
- Branch: `dsh-managed-presets`
- Fixed point: `1bb01fd` (main)
- Implementation commits: `3d437a6` (`feat(dsh): manage compatible stock presets`),
  `3e3e95c` (`fix(dsh): harden managed preset synchronization`), and `e9ca3b8`
  (`fix(dsh): require explicit provider wiring`)
- Delivery boundary: the complete `dsh-managed-presets` spec and tickets 01–04.
  Code review and deployment were outside the Implementation worker's scope.

## Ticket outcomes

### 01 — Own the complete DSH Research Surface

- Replaced the official Web registry/provider integration with direct Guion
  ownership of `web_search`, `web_fetch`, `web_links`, `web_docs`, and
  `web_source_search`.
- Preserved live Exa, Brave, DeepSeek, and Kepos Bridge selection and
  namespaced credential resolution. Search validates one-to-four trimmed
  queries, runs them concurrently, merges successful results deterministically,
  reports partial/total failures, forwards cancellation, and bounds rendered
  model text.
- Retained the complete fetch navigation and rendering contract (`mode`,
  `section_id`, `render`, and `waitMs`) and the provider-conditional Kepos
  tools.
- Removed the obsolete provider module, official Web peer/development
  dependency, and registry injection. Packed host, client, tool, and schema
  tests cover the owned surface.

### 02 — Sync and diagnose managed presets

- Added `web dsh sync` and read-only `web dsh doctor` with DSH executable
  discovery, standard `DSH_HOME` resolution, explicit test-owned path seams,
  exact official preset-package version validation, source identity markers,
  structural `tool-web` removal, and complete source-tree validation.
- Sync creates or refreshes marked same-id `standard`, `ptc`, `cordis`, and
  `minimal` snapshots under `.agent-presets`; it stages writes, preflights all
  conflicts, preserves unmarked user data, and rolls back managed replacements
  when a filesystem operation is interrupted. Each rename revalidates
  ownership, verifies a moved backup marker before it can be deleted, preserves
  unknown races, and removes newly installed targets during rollback.
- Doctor compares every managed file byte-for-byte with the expected
  transformed source snapshot (while allowing only the generated marker), so
  deletion, tampering, and unexpected copied files are reported as incomplete.
  The source package manifest and version are authoritative; version override
  seams and unused path aliases/helpers were removed. Fixture tests cover
  source-file deletion/tampering, deterministic ownership races, and injected
  mid-swap rollback.

### 03 — Hide shipped presets end to end

- Updated the bundle patch to disable the complete official Web stack and the
  scoped `tool-web` row, while targeting the existing `agent-presets` row with
  `includeShippedRoot: false`, `includeUserRoot: true`, and `default: standard`.
- Parsed and packed artifact tests assert the full patch and peer-only package
  contract, including the absence of `@deepseek-ai/dsh-web`.
- Completed packed Linux validation against the official rc.1 Loader path and
  disposable DSH home (details below).

### 04 — Document the managed preset workflow

- Updated the root and DSH-package READMEs with sync-before-activation,
  doctor, hidden shipped-root, same-id ownership/conflict, upgrade refresh, and
  effective Guion schema guidance.
- Added the DSH vocabulary to `CONTEXT.md`, recorded the ownership decision in
  ADR 0004, and added test-owned/real-Linux requirements to `AGENTS.md`.
- The root/package READMEs, `CONTEXT.md`, and `AGENTS.md` are the only project
  documents that describe this workflow; no other project documentation
  exposes a DSH preset contract requiring an update.

## Changed paths

- `AGENTS.md`
- `CONTEXT.md`
- `README.md`
- `docs/adr/0004-dsh-research-surface-owner.md`
- `packages/dsh-web/README.md`
- `packages/dsh-web/cordis.patch.yml`
- `packages/dsh-web/package.json`
- `packages/dsh-web/src/client.ts`
- `packages/dsh-web/src/contract.ts`
- `packages/dsh-web/src/index.ts`
- `packages/dsh-web/src/provider.ts` (removed)
- `packages/dsh-web/src/tools.ts`
- `packages/dsh-web/test/artifact.test.ts`
- `packages/dsh-web/test/client.test.ts`
- `packages/dsh-web/test/package.test.ts`
- `packages/dsh-web/test/provider.test.ts` (removed)
- `packages/dsh-web/test/tools.test.ts`
- `packages/dsh-web/tsup.config.ts`
- `packages/web/src/dsh.ts`
- `packages/web/src/program.ts`
- `packages/web/src/runner.ts`
- `packages/web/test/dsh.test.ts`
- `packages/web/test/packed-smoke.mjs`
- `pnpm-lock.yaml`

## Verification

All final local checks passed:

- `pnpm install --frozen-lockfile --ignore-scripts`
- `pnpm typecheck`
- `pnpm test` — 20 files, 163 tests passed
- `pnpm format:check`
- `pnpm build` — all four package builds passed
- `pnpm test:pack` — Web, Pi, and DSH packed smoke tests passed
- `pnpm test:release`
- `git diff --check`

The blocker pass added packed Web CLI coverage with a fake installed DSH and
agent-presets graph under a test-owned temporary directory. It invokes
`dsh sync` and `dsh doctor` through PATH discovery with a disposable DSH_HOME;
no source paths or live state are injected.

The updated Linux validation ran on NUC `kosmos-wsl` (Linux, Node
`v24.19.0`) under the disposable work directory
`/tmp/guion-dsh-linux-blocker-final-ss2sfY`. The blocker run reused the prior
disposable official install at
`/tmp/guion-dsh-linux-final-heK1hs/install` rather than reinstalling DSH; that
install contains the official `@deepseek-ai/dsh@0.1.2-rc.1` and
`@deepseek-ai/dsh-agent-presets@0.1.2-rc.1` graph. The current packed artifacts
and test-owned paths were:

- Web bundle: `/tmp/guion-dsh-linux-blocker-final-ss2sfY/guionai-web-0.1.0.tgz`
- DSH bundle: `/tmp/guion-dsh-linux-blocker-final-ss2sfY/guionai-dsh-web-0.1.0.tgz`
- Packed Web CLI: `/tmp/guion-dsh-linux-blocker-final-ss2sfY/webcli/node_modules/.bin/web`
- DSH entrypoint: `/tmp/guion-dsh-linux-final-heK1hs/install/node_modules/@deepseek-ai/dsh/lib/bin.js`
- DSH home: `/tmp/guion-dsh-linux-blocker-final-ss2sfY/home`
- Profile: `/tmp/guion-dsh-linux-blocker-final-ss2sfY/home/profiles/web`
- Probe: `/tmp/guion-dsh-linux-blocker-final-ss2sfY/home/profiles/probe`

The Web CLI install was performed in the test-owned `webcli` directory:

```sh
cd /tmp/guion-dsh-linux-blocker-final-ss2sfY/webcli
HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/home-home XDG_CACHE_HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/cache npm_config_store_dir=/tmp/guion-dsh-linux-blocker-final-ss2sfY/store pnpm install --offline --ignore-scripts --frozen-lockfile=false
```

The profile install used the current packed DSH bundle and probe from the
test-owned profile directory:

```sh
cd /tmp/guion-dsh-linux-blocker-final-ss2sfY/home/profiles/web
HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/profile-home-repro XDG_CACHE_HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/profile-cache-repro npm_config_store_dir=/tmp/guion-dsh-linux-blocker-final-ss2sfY/profile-store-repro pnpm install --offline --ignore-scripts --frozen-lockfile=false
```

These are the complete runtime commands used (all paths are explicit; there
are no source-path overrides):

```sh
PATH=/tmp/guion-dsh-linux-final-heK1hs/install/node_modules/.bin:/run/current-system/sw/bin HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/home DSH_HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/home /tmp/guion-dsh-linux-blocker-final-ss2sfY/webcli/node_modules/.bin/web dsh sync
PATH=/tmp/guion-dsh-linux-final-heK1hs/install/node_modules/.bin:/run/current-system/sw/bin HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/home DSH_HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/home /tmp/guion-dsh-linux-blocker-final-ss2sfY/webcli/node_modules/.bin/web dsh doctor
PATH=/run/current-system/sw/bin HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/home DSH_HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/home node --expose-internals /tmp/guion-dsh-linux-final-heK1hs/install/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config
PATH=/run/current-system/sw/bin HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/home DSH_HOME=/tmp/guion-dsh-linux-blocker-final-ss2sfY/home PROBE_OUT=/tmp/guion-dsh-linux-blocker-final-ss2sfY/probe-repro.json node --expose-internals /tmp/guion-dsh-linux-final-heK1hs/install/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --host 127.0.0.1 --port 0
```

Captured command output was:

```text
DSH managed presets created all four presets from @deepseek-ai/dsh-agent-presets@0.1.2-rc.1.
Preset root: /tmp/guion-dsh-linux-blocker-final-ss2sfY/home/.agent-presets
DSH doctor: OK
- standard: ok
- ptc: ok
- cordis: ok
- minimal: ok
dsh web: http://127.0.0.1:44554/?token=REDACTED
```

The probe's roster/composition summary was:

```text
standard user rows=26 tool-web=[]
ptc user rows=27 tool-web=[]
minimal user rows=8 tool-web=[]
cordis user rows=27 tool-web=[]
```

The probe's schema summary was:

```text
web_fetch properties=url,mode,section_id,render,waitMs required=url
web_search properties=queries required=queries
```

The dump contained `includeShippedRoot: false`, `includeUserRoot: true`, and
`default: standard`; the profile process was stopped after the probe completed.
Every home, profile, probe, and packed bundle path above was test-owned and
disposable, and no live DSH home, credentials, overrides, or services were
read or modified.

Vitest emits the existing non-failing missing source-map warning from the DSH
primitives package.

## LOC accounting

Against fixed point `1bb01fd`, excluding the lockfile, generated artifacts,
ignored tracker files, and this report:

| Category               | Additions | Deletions |
| ---------------------- | --------: | --------: |
| Product code           |     1,528 |       179 |
| Tests                  |       900 |       316 |
| Configuration and docs |       224 |        25 |
| **Total**              | **2,652** |   **520** |

The estimate was 1,070–1,820 changed lines. The material variance comes from
the complete filesystem-safe runtime discovery, source validation, staging, and
rollback path plus the required fixture and packed Loader coverage; no
compatibility migration, live-state fallback, or unrelated optional feature was
added.

## Acceptance result

Tickets 01, 02, 03, and 04 and the complete spec are implemented and verified.
The implementation is committed as `3d437a6`, `3e3e95c`, and `e9ca3b8`; the report update
is committed separately. Code review and deployment were outside the
Implementation worker's scope.
