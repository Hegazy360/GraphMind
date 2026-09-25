# Bundled price table

`data_slim.json` is a verbatim snapshot of
[genai-prices](https://github.com/pydantic/genai-prices) by Pydantic
(`prices/new_data/v2/data_slim.json`), MIT-licensed — see `LICENSE` here; the
same notice ships in the built viewer as `public/THIRD_PARTY_NOTICES.txt`.

- **Date shown in the UI** ("≈ est. (prices as of …)"): `PRICE_SNAPSHOT.date`
  in `snapshot.ts`. The JSON carries no date of its own, so the date is
  recorded there, together with the upstream commit the file matches and the
  file's SHA-256 (the unit suite pins the hash, so a refreshed file with a
  stale date fails `test/prices.test.ts`).
- **Loading**: `loader.ts` pulls the file with a dynamic `import()`, so it is
  its own build chunk (~334 KB, ~35 KB gzipped) and is fetched only once the
  viewer shows a run with LLM token usage (the top bar's est. cost, the
  inspector, Context & cost) — never for a run without. An exported
  single-file run (`graphmind record --html`) has no sibling chunks and must
  not look for one (an inlined module's relative `import()` resolves against
  the document): the exporter embeds the table as a JSON block
  (`<script type="application/json" id="graphmind-prices">`, read out of the
  built chunk by `packages/cli/src/export-html.ts`) when the run has usage,
  and `loader.ts` reads that block before it would import. Where the table
  cannot load at all, the view shows no dollar figures and says so.
- **Matching and cost math**: `engine.ts` (mirrors the upstream JS engine;
  unknown model → no price).

To refresh: download the file from the source URL in `snapshot.ts`, replace
`data_slim.json`, update every field of `PRICE_SNAPSHOT` (date, upstream
commit, SHA-256) and the snapshot line in `public/THIRD_PARTY_NOTICES.txt`.
