// The newest schema and processing versions the released app writes into a log entry (docs/privacy.md 5.3): the
// server refuses an entry with a newer one, and a device that meets a newer one asks for an update.
// 2 (Nov 13, 2026): entries carry the bank log's tables (D-103). An app that knows only 1 asks for an update
// instead of refusing their rows.
export const LOG_SCHEMA_VERSION = 2;
export const LOG_PROCESSING_VERSION = 1;
