-- Worker requests today (100,000 a day on Free) for the breaker: the one daily limit it didn't watch. Expand-only.
ALTER TABLE usage_day ADD COLUMN worker_requests INTEGER NOT NULL DEFAULT 0;
