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
  its own build chunk (~334 KB, ~35 KB gzipped) and is fetched only when an
  LLM step's Context & cost view opens. An exported single-file run
  (`graphmind record --html`) has no sibling chunks; there the view shows no
  dollar figures and says the prices did not load.
- **Matching and cost math**: `engine.ts` (mirrors the upstream JS engine;
  unknown model → no price).

To refresh: download the file from the source URL in `snapshot.ts`, replace
`data_slim.json`, update every field of `PRICE_SNAPSHOT` (date, upstream
commit, SHA-256) and the snapshot line in `public/THIRD_PARTY_NOTICES.txt`.
