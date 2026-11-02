-- Quarterly and yearly refill targets: the target screen saved the chosen Due month (the last month of a period) as
-- period_anchor, which is the first month of a period, so each target came due a month early. Every such row in use
-- was saved by that screen; move its anchor to the start of the period that ends in the Due month.
UPDATE target
SET period_anchor = strftime('%Y-%m', period_anchor || '-01', printf('%d months', 1 - period_months))
WHERE type = 'refill' AND period_months > 1 AND period_anchor IS NOT NULL;
