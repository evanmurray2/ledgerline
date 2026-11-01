-- A bank link is saved the moment Plaid confirms it (with its encrypted access token), before its accounts are set
-- up, so a failure in between can never lose a link that already counts toward the 10. setup_done = 0 marks a link
-- whose accounts still need setting up: syncs skip it, and Bank connections offers "Finish setup". Existing links
-- are complete.
ALTER TABLE connection ADD COLUMN setup_done INTEGER NOT NULL DEFAULT 1;
