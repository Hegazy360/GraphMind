/**
 * Provenance of the bundled price table (`data_slim.json`, genai-prices by
 * Pydantic, MIT — the license travels next to it as `LICENSE` and ships in
 * the built viewer as `THIRD_PARTY_NOTICES.txt`).
 *
 * `date` is what the viewer prints as "prices as of …". It is the day the
 * snapshot was taken from upstream `main`, which is also the committer date
 * of the upstream commit the file matches (identified by content: it has
 * the Doubleword DeepSeek V4.1 Flash entry added in #699 and not the
 * `gpt-6-sol` entry added in #708 later the same day). The JSON itself
 * carries no date, so this file is the record.
 *
 * Refreshing the snapshot = replace `data_slim.json` from `source`, then
 * update every field here. test/prices.test.ts pins `sha256` against the
 * bundled bytes, so a refreshed table with a stale date fails the suite.
 */
export const PRICE_SNAPSHOT = {
  /** ISO date shown to the user. */
  date: '2026-09-22',
  source:
    'https://raw.githubusercontent.com/pydantic/genai-prices/main/prices/new_data/v2/data_slim.json',
  /** Upstream commit (pydantic/genai-prices) whose data_slim.json this is. */
  upstreamCommit: '02cb80a15d',
  /** SHA-256 of the bundled data_slim.json. */
  sha256: '36e45093e3ea9cfb240e95951788bee13883422688dcb89510206096d830eca9',
  license: 'MIT — Copyright (c) Pydantic Services Inc. 2025 to present',
} as const;

/** The label every dollar figure carries. */
export const EST_LABEL = `≈ est. (prices as of ${PRICE_SNAPSHOT.date})`;
