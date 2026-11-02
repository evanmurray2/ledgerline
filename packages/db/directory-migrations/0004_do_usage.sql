-- Durable Object requests and active time (GB-s) for the write breaker (decisions.md D-37): the two Free limits
-- that ran out on Nov 2, 2026. Expand-only.
ALTER TABLE usage_day ADD COLUMN do_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_day ADD COLUMN do_gbs REAL NOT NULL DEFAULT 0;
