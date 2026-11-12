// The newest schema and processing versions the released app writes into a log entry (docs/privacy.md 5.3): the
// server refuses an entry with a newer one, and a device that meets a newer one asks for an update.
export const LOG_SCHEMA_VERSION = 1;
export const LOG_PROCESSING_VERSION = 1;
