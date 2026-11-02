-- Local dev and tests only (production has no D1 since Nov 2, 2026): the same usage_day columns as the
-- Directory's migration 0004, so the shared breaker code runs on both.
ALTER TABLE usage_day ADD COLUMN do_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_day ADD COLUMN do_gbs REAL NOT NULL DEFAULT 0;
