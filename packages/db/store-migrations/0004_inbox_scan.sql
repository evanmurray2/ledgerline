-- The daily scans the server ran (docs/privacy.md 5.4, phase 4), kept beside the bank updates of the inbox so
-- that a device can run the same scans in the same place among them and the results can be compared.
--
-- Two daily jobs are noted: the scan (5:00), and the maintenance (2:20), whose one write a device can repeat is
-- the watchdog's (it notes that it ran, and drops old card snapshots). For the maintenance, `at` is the clock of
-- that step.
--
-- For the scan, `at` is its planned time (5:00 in the budget's time zone; daily-scan.ts scanTime): all a device needs to
-- run the same scan. `base_version` and `end_version` are `budget.data_version` before and after it. A scan
-- moves that number itself, by one; a bank update never does. So the numbers also say where a scan stands among
-- the updates: an update that began at a scan's `base_version` came before it.
CREATE TABLE inbox_scan (
  n INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('scan', 'maintenance')),
  at INTEGER NOT NULL,
  base_version INTEGER NOT NULL,
  end_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
