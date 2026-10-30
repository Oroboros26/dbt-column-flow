# Changelog

## [0.3.3]

- Add a third AI fallback wire format, `azure`, for Azure AI Foundry
  model-catalog/serverless deployments (`*.services.ai.azure.com` /
  `*.models.ai.azure.com`). New `voroColumnFlow.ai.azureApiVersion` setting.
  Note: classic `*.openai.azure.com` resources use a different auth/URL shape
  and are not covered by this

## [0.3.2]

- Fix: the toolbar didn't wrap, so on a narrower window the right-hand
  buttons — including the new AI ones — could be pushed off-screen with no
  way to reach them. Toolbar now wraps to a second line instead

## [0.3.1]

- The graph toolbar now shows the AI fallback's on/off state directly, plus
  **Set AI Key** / **Clear AI Key** buttons — the whole enable → set key →
  use → delete key lifecycle is now reachable without leaving the graph or
  using the Command Palette. Clearing the key asks for confirmation first

## [0.3.0]

- Clicking a column now also opens a side panel listing its full trace as an
  ordered path ("where it came from" / "where it goes"), instead of relying
  only on following highlighted lines across the graph. Clicking an entry
  re-roots the canvas on that model
- New **optional, off-by-default** AI fallback for edges the SQL parser
  couldn't resolve: a "Resolve with AI" button on unresolved edges sends just
  that edge's model/column names and the target model's SQL to a
  user-configured endpoint (any OpenAI-compatible or Anthropic-compatible
  provider/model). API key is stored in VS Code secret storage, never in
  settings. See `voroColumnFlow.ai.*` settings and the **Set/Clear AI API
  Key** commands

## [0.2.1]

- Add a dedicated **Columns** search — a separate toolbar button/panel next to
  the model picker, searching column names directly across every model.
  Replaces the 0.2.0 attempt, which wired column matching into the model
  picker's search box and never actually triggered for plain text queries
- Picking a column result jumps to that model as the graph root and
  auto-traces the column's trajectory, same as clicking it in the graph

## [0.2.0]

- Search box now matches column names, not just model names — typing a column
  name shows every model that has it and auto-selects it, tracing its
  trajectory across the graph just like clicking it would

  **Note:** this didn't actually work — the column-matching logic was wired to
  a piece of state the visible search box never wrote plain text into.
  Superseded by the dedicated Columns panel in 0.2.1.

## [0.1.2]

- Fix a race condition where the extension could report "no dbt_project.yml in
  this workspace" on first activation in large projects, because the project
  lookup depended on VS Code's file-search index before it had finished
  warming up. The workspace-folder root is now checked directly first
- `VORO Column Flow: Refresh` now retries the project lookup if it previously
  failed, instead of requiring a full window reload

## [0.1.1]

- Fix `.vscodeignore` pattern ordering that leaked source maps (~20MB) into the packaged `.vsix`
- Rewrite README with clearer install instructions and project overview

## [0.1.0]

First release.

- Column-level lineage from `manifest.json`, rendered with ReactFlow
- Optional `catalog.json` enrichment: exact columns and data types
- Explore mode — pick a root model, then choose upstream/downstream depth
- Edge confidence tiers: parsed, likely, conflict, unknown
- Column trajectory tracing with upstream / both / downstream direction
- dbt selector syntax (`+model`, `model+`, `2+model+1`)
- Per-adapter SQL dialect, read from `manifest.metadata.adapter_type`
- Source schema inference from downstream SQL when sources declare no columns
- Models sidebar, CodeLens on `.sql` files, PNG export, live refresh on manifest change
- ANSI welcome banner on first activation, reporting what was actually loaded
