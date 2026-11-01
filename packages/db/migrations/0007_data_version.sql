-- Bumped by every successful change through the API and by daily jobs; part of every screen's ETag, so a phone that
-- already has a screen gets "304 Not Modified" for a couple of rows read instead of the whole screen (see
-- apps/worker/src/http/etag.ts). Syncs and recomputes are covered by their own counters.
ALTER TABLE budget ADD COLUMN data_version INTEGER NOT NULL DEFAULT 0;
