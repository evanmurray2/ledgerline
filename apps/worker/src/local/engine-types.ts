// The shapes the phone's engine and the web app pass each other (apps/web/src/copy/host.ts). Types only, with no
// import of the Worker's or Cloudflare's code, so the web app's type check can read this file.
import type { SyncRow } from '../sync-tables.js';

export interface EngineIdentity {
  budgetId: string;
  userId: string;
  email: string;
  /**
   * The account can't link banks (the server said so). The copy answers the session's setup step with it; left
   * out, the copy answers as the budget's owner.
   */
  noBanks?: boolean;
}

export interface EngineState {
  /** Change number the copy holds (0: nothing yet). */
  through: number;
  epoch: string | null;
  format: number;
  /** Set only in a copy left by an app from before the log: a download it never finished. */
  cursor: string | null;
  /** Server time when the copy last moved, and how far this device's clock is from the server's (ms). */
  serverTime: number | null;
  offset: number;
}

/**
 * An edit kept on the device until the server takes it. The engine owns the queue (`local_state`, key `outbox`):
 * every change to it is one step of the engine, so the copy and its queue can't come apart.
 */
export interface QueuedEdit {
  id: string;
  at: number;
  method: string;
  path: string;
  body: unknown;
  appVersion?: string;
  /**
   * What takes the edit back out of the copy, and the change number the copy held when the edit ran. The undo is
   * good only while the copy still holds that number. An edit with neither (queued by an older app, or after the
   * copy was downloaded again) can only be sent.
   */
  undo?: SyncRow[];
  through?: number;
  /**
   * The rows the edit changed, as they were after it: what the edit's entry in the log holds (local/log-session.ts).
   * Made again whenever the edit is run again.
   */
  rows?: SyncRow[];
  /**
   * Not an edit: bank runs this device filed (`LocalEngine.fileBank`), waiting to become a bank entry of the log.
   * Always first in the queue: the edits after it ran on top of it. It is never run again by the engine (the
   * runs are not kept here): when it must come out, it is dropped, and the device files the runs again.
   */
  /** Bank runs filed (or, with `scanThrough`, one day's scan): sent as a bank or scan entry (local/log-session.ts). */
  bank?: { filedThrough: number; receipts: string[]; scanThrough?: number };
}

/** Another device that showed different numbers at the same entry and month. */
export interface DevicesDiffer {
  deviceId: string;
  number: number;
  month: string;
}
