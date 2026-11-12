-- The snapshot a check was built on (docs/privacy.md 5.3). A check record says a device rebuilt the budget from
-- an older snapshot plus the entries since and got the same; `check_base` names that older snapshot. The delete
-- rule keeps exactly that one: a snapshot that no check was built on, or that a check refused, never becomes what
-- the budget is rebuilt from.
ALTER TABLE snapshot ADD COLUMN check_base TEXT;
