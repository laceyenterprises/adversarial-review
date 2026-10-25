-- Optional key lives in the extensible payload; legacy ticks remain append-only.
CREATE UNIQUE INDEX IF NOT EXISTS idx_finalization_shadow_dedupe
  ON finalization_shadow(json_extract(payload_json, '$.dedupeKey'))
  WHERE json_extract(payload_json, '$.dedupeKey') IS NOT NULL;
