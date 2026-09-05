# Make Guion the single owner of the DSH Research Surface

## Status

Accepted

## Context

Guion's DSH integration previously selected a Guion provider through the
official DSH Web registry while the official `tool-web` plugin supplied the
model-facing `web_search` and `web_fetch` surface. A scoped official row in a
preset could therefore change the effective tools between native and PTC
modes, and the profile carried duplicate provider and Web-suite ownership.

## Decision

This decision targets DeepSeek Harness `0.1.2-rc.1`.

`@guionai/dsh-web` directly registers the complete DSH Research Surface:
`web_search`, `web_fetch`, `web_links`, `web_docs`, and `web_source_search`,
with the Kepos-only `web_weather`, `web_sports`, `web_finance`, and `web_time`
registrations enabled only while Kepos Bridge is selected. Search reads the
live Guion provider and namespaced credential for every execution. The plugin
does not register with or depend on the official DSH Web provider registry.

The profile patch disables `dsh-web`, `web-search-deepseek`, `web-fetch-http`,
and `tool-web`, then mounts only the Guion host plugin with its credential,
settings, and tools services. The bundle also patches the official
`agent-presets` row with `includeShippedRoot: false`, `includeUserRoot: true`,
and `default: standard`. DSH prepends shipped presets and lets them win
same-id duplicates, so the shipped root must be hidden for compatible copies
to take effect.

`web dsh sync` reads the installed official
`@deepseek-ai/dsh-agent-presets@0.1.2-rc.1` tree and writes full snapshots of
`standard`, `ptc`, `cordis`, and `minimal` under the user preset root. It
removes only the expected top-level official `tool-web` row from the first
three. Sync compares existing directories with the official and compatible
trees, refreshes exact matches automatically, and requires interactive
confirmation or `--yes` before replacing modified same-id content. It never
edits the shipped package. `web dsh doctor` performs the corresponding
read-only checks.

## Consequences

Provider selection and credentials remain one live Guion settings surface, and
native and PTC calls receive the same registered tools. Official shipped
presets remain deployment-owned and untouched; their same-id compatible copies
are the supported path because the bundle hides the shipped root while
retaining Yuki and other ordinary user presets. Existing sessions, credentials,
and deployed profiles are not migrated automatically. Runtime upgrades require
an explicit sync, and deployment remains a separate operator action.

The root and package READMEs, `CONTEXT.md`, and `AGENTS.md` are the only project
documents that describe this operator and agent workflow; no other project
documentation exposes a DSH preset contract that needs updating.
