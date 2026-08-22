# Guion Web

Guion Web is a Node.js web research toolkit. It provides Exa or Brave search,
browserless HTML-to-Markdown extraction, Context7 library documentation lookup,
and Sourcegraph public code search through a CLI, stdio MCP server, Pi extension,
and DeepSeek Harness (DSH) integration.

## Install and configure

Node.js 20 or later is required.

```bash
npm install --global @guionai/web
# or run without a global install
npx @guionai/web --help
```

Search needs one provider credential. If both are present, Exa is selected by
default; select a provider explicitly with `--provider exa` or `--provider brave`.
Context7 works anonymously when its key is absent.

```bash
export EXA_API_KEY="..."
# or
export BRAVE_API_KEY="..."
# optional, for authenticated Context7 requests
export CONTEXT7_API_KEY="..."
```

Do not put credentials in command arguments or commit them. The CLI reads these
environment variables directly; it does not load a dotenv file or an older
application configuration path.

## CLI

`web` has human-readable output by default. Add `--json` for exactly one JSON
document on stdout, which is useful for automation.

```bash
web search --provider exa -- "Node AbortSignal"
web fetch https://example.com/article --tree
web fetch https://example.com/article --section introduction
web docs resolve react
web docs fetch /facebook/react --topic hooks --tokens 2000
web sgraph --count 10 -- "repo:^github\\.com/nodejs/node$ AbortSignal"
```

Use `--` before a search or Sourcegraph query that begins with a hyphen. `fetch`
supports `--full`, `--tree`, and `--section`; long extracted documents default to
a heading tree so a later request can retrieve a stable section ID.

## MCP

Run the stdio server with the same credential environment:

```bash
web mcp
# Pin search selection for the lifetime of this MCP process:
web mcp --provider brave
```

The server exposes five read-only tools: `search`, `fetch`, `docs_resolve`,
`docs_fetch`, and `sgraph_search`. Its stdout is reserved for MCP protocol
messages; diagnostics go to stderr.

## Pi

Install the independently bundled Pi extension:

```bash
pi install npm:@guionai/pi-web
```

It registers `web_search`, `web_fetch`, `web_docs`, and `web_sgraph` and calls
the bundled core in-process. Pi and TypeBox are peer dependencies supplied by
the host; no CLI executable or MCP configuration is required.

## DSH

Install the DSH bundle in the existing Web profile:

```bash
dsh plugin --profile web add @guionai/dsh-web
```

The included profile patch routes stock PTC web search through the selected Exa
or Brave provider. Its settings UI stores provider selection and manages
namespaced write-only credentials. Fetch, documentation, and Sourcegraph tools
also run in-process. The host DSH packages and React are peers supplied by DSH.

## Browserless boundary

Page extraction uses Node `fetch`, `linkedom`, and Defuddle to turn static HTML,
server-side-rendered pages, and pre-rendered pages into clean Markdown. It does
not execute page JavaScript, launch a browser, use Playwright or Chromium, or
support true client-rendered SPA rendering. A page whose meaningful content is
created only by client JavaScript therefore needs a browser-capable tool.

## Development

This is a pnpm workspace. Install dependencies and run the same local gates
used by CI:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
pnpm test:release
pnpm test:artifacts
pnpm test:pack
```

`test:release` uses disposable manifests and a fake npm executable to exercise
version synchronization, stable/beta dist-tags, exact-version skipping, and
fail-closed registry responses. `test:artifacts` and `test:pack` pack all three
public packages into test-owned temporary directories and validate their
published contracts. `test:windows` is the focused Windows CI smoke for packed
CLI installation and the `LOCALAPPDATA` cache path.

## Releases

A `v<semver>` tag is the release source of truth for all three public packages:
`@guionai/web`, `@guionai/pi-web`, and `@guionai/dsh-web`. The release workflow
synchronizes its checkout manifests from that tag. A stable version publishes
with npm's `latest` tag; any SemVer prerelease publishes with `beta`.

The release preflight builds, tests, packs, validates artifacts, synchronizes
versions, and checks the release plan. Its protected `npm` Environment job then
queries npm for each exact immutable package version. Existing exact versions
are skipped; authentication, network, malformed, or ambiguous responses fail
the release. Remaining packages publish sequentially with `npm publish --access
public --tag <derived-tag> --provenance`. Only after all three publishes succeed
does the workflow create the GitHub release with generated notes and source
archives. It publishes no binaries or platform archives.

### First beta bootstrap and Trusted Publishing

Do this once after the release commit is merged, before enabling routine OIDC
releases:

1. Check out a clean intended release commit and choose a synchronized beta
   version such as `0.1.0-beta.1`.
2. With a maintainer npm account that has `@guionai` publish permission and 2FA,
   run `node scripts/sync-version.mjs 0.1.0-beta.1`, then run the build, test,
   artifact, pack, and `node scripts/release-dry-run.mjs 0.1.0-beta.1` gates.
3. Publish the three-package plan manually with `node scripts/publish-packages.mjs`.
   This bootstrap is authenticated by the maintainer; do not pass provenance
   outside the GitHub OIDC release job.
4. In npm package settings, create one GitHub Trusted Publisher relationship
   for each of `@guionai/web`, `@guionai/pi-web`, and `@guionai/dsh-web`. Each
   must target repository `guionai/web`, workflow `.github/workflows/release.yaml`,
   and the protected `npm` Environment.
5. Verify all three relationships and npm publishing-access policies in npm,
   then enable/tag the routine release workflow. It uses GitHub OIDC with no
   npm token and requests provenance for every normal publication.

Never use the release scripts to overwrite or unpublish a version. They are
intentionally resumable only at exact immutable npm versions.
