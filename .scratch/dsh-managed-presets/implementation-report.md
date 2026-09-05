# DSH compatible presets implementation report

## Scope

- Repository: `guionai/web`
- Branch: `dsh-managed-presets`
- Fixed point: `1bb01fd` (`main`)
- Final implementation commit: `3d7d4a1` (`refactor(dsh): simplify compatible preset sync`)
- Delivery boundary: the complete `dsh-managed-presets` spec and tickets 01–04.

## Outcome

Guion's DSH bundle now owns the complete research surface:
`web_search`, `web_fetch`, `web_links`, `web_docs`, and
`web_source_search`. The official Web registry/provider integration and
dependency are gone. The Guion implementations retain the selected search
providers, namespaced credentials, fetch navigation/rendering options,
cancellation, bounded output, and conditional Kepos tools.

The bundle patch disables the official Web stack and hides shipped presets.
It exposes only the user preset root, with `standard` as the default. The
effective Guion schemas remain:

- `web_search`: required `queries`
- `web_fetch`: required `url`; optional `mode`, `section_id`, `render`, and
  `waitMs`

## Compatible preset workflow

`web dsh sync` creates or refreshes `standard`, `ptc`, `cordis`, and `minimal`
under the DSH user preset root. Each copy comes from the installed official
`@deepseek-ai/dsh-agent-presets` package with the official `tool-web` entry
removed structurally.

There is no Guion marker file or persistent ownership metadata. For each
same-ID directory, sync compares the complete tree with two snapshots:

- an exact current compatible copy is safe to refresh;
- an exact official copy is safe to convert;
- any other content is treated as user-modified and requires interactive
  confirmation, or `--yes` in automation.

Non-interactive sync refuses modified same-ID directories unless `--yes` is
present. Unrelated user presets are untouched. Replacement is staged per
preset, with a local backup restored if installation fails; there is no global
four-preset transaction or speculative race-hook machinery.

`web dsh doctor` is read-only and reports each compatible preset as `ok`,
`missing`, `stale` (an exact official copy), or `conflict` (any other content).

## Documentation

The workflow and the requirement to sync before selecting a compatible preset
are documented in the root README and `packages/dsh-web/README.md`.
`CONTEXT.md` defines the vocabulary, ADR 0004 records the ownership decision,
and `AGENTS.md` records the test-state and real-Linux verification rules.

## Verification

Final local checks passed:

- `pnpm test` — 20 files, 161 tests
- `pnpm typecheck`
- `pnpm build` — all four packages
- `pnpm test:pack` — Web, Pi, and DSH package smoke checks
- `pnpm format:check`
- `pnpm test:release`
- `git diff --check`

The packed Web smoke no longer contains a fake DSH installation or a second
sync/doctor test graph. Runtime discovery is covered by focused temporary
filesystem tests, including a standard `node_modules/.bin/dsh` shim.

The real integration check ran on `nuc-kep` from the existing checkout
`/home/neil/code/projects/guionai/web`. `og pull` first fast-forwarded its
current `main`; because `og pull` only fetches the current branch, the new
remote feature ref was then fetched and checked out. The checkout was built
with its installed pnpm, and the built Web CLI called the NUC's installed
`dsh` executable. All mutable DSH state was isolated under:

```text
/tmp/guion-dsh-checkout.q3UxVE/dsh-home
```

The disposable profile linked the checkout's current `@guionai/dsh-web`
package. No live yuki profile, credentials, preset root, or service was read or
changed.

Observed results:

```text
DSH compatible presets created all four presets from @deepseek-ai/dsh-agent-presets@0.1.2-rc.1.
DSH doctor: OK
- standard: ok
- ptc: ok
- cordis: ok
- minimal: ok
```

The same run then exercised the overwrite policy:

1. Replacing `standard` with the exact installed official preset was accepted
   and converted without a prompt.
2. Adding a user edit to `ptc` made non-interactive sync exit with status 1:
   `refusing to overwrite modified same-id preset ptc; rerun interactively or pass --yes`.
3. Re-running with `--yes` refreshed all four presets, after which doctor was
   fully green again.

The same disposable profile was then composed by the installed official Loader
with a read-only probe bundle. The reconciled config contained
`includeShippedRoot: false`, `includeUserRoot: true`, and `default: standard`;
the installed `@guionai/dsh-web` link resolved exactly to the NUC checkout.
The Loader booted successfully and was stopped immediately after the probe:

```text
standard user rows=26 broken=absent tool-web=0
ptc user rows=27 broken=absent tool-web=0
minimal user rows=8 broken=absent tool-web=0
cordis user rows=27 broken=absent tool-web=0
web_fetch properties=url,mode,section_id,render,waitMs required=url
web_search properties=queries required=queries
```

The probe output is `/tmp/guion-dsh-checkout.q3UxVE/probe.json`. The disposable
Loader process was confirmed stopped, and its token-bearing launch URL was not
recorded.

Vitest emits the existing non-failing missing source-map warning from the DSH
primitives package.

## Size

Against `1bb01fd`, excluding the lockfile and this report, the final diff is
2,144 additions and 521 deletions (2,665 changed lines). The simplified sync
removed 901 lines and added 392 relative to the previously reviewed branch:
the marker protocol, global transaction, injected rename hooks, shim-text
parser, and packed fake-DSH smoke were deleted.

## Acceptance result

The whole spec is implemented and verified. The final workflow uses content
comparison plus explicit confirmation, keeps upstream DSH unchanged, and uses
the NUC's real CLI for Linux integration verification.
