// The copy's state as the screens see it (copy.ts sets it): its status, and the listeners screens use to render again
// and to refetch when the copy changes. Split from copy.ts, which re-exports it.
import { useSyncExternalStore } from 'react';
import { createListeners } from '../lib/store';
import type { DevicesDiffer } from './host';

export type CopyStatus =
  | 'off' // the mock API (development and tests)
  | 'idle' // nobody signed in yet
  | 'signed_out' // a saved copy waits: Sign in opens it online, or Face ID with no signal
  | 'opening'
  | 'ready'
  | 'fresh' // a new budget with no first entry yet: this device makes it (lockStart, lockFinish)
  | 'failed';

export interface CopyState {
  status: CopyStatus;
  /** Saved encrypted on this device (vs. memory only). */
  saved: boolean;
  /** Opened with no signal: view and the offline edits only. */
  offline: boolean;
  /** Downloading: rows so far. */
  progress: number;
  /** Why everything is being downloaded, not just what changed (null: only changes). */
  why: FullWhy | null;
  error: string | null;
  /** Changes made offline not yet on the server. */
  queued: number;
  /** A saved copy exists for someone on this device (offline opening is possible). */
  hasSaved: boolean;
  /**
   * The budget is locked and the passkey just used is no way in to it (a new passkey, after a recovery): the
   * recovery key opens it (`openWithRecovery`).
   */
  needsRecovery?: boolean;
  /** The copy is being made again from the budget's newest snapshot (a sealed budget): "Bringing your budget up to date". */
  rebuilding?: boolean;
  /**
   * The server showed this device a history that is not the one it saw (docs/privacy.md 5.3, a fork or a rollback).
   * The device stops; nothing was changed.
   */
  forked?: boolean;
  /** Another device showed different numbers at the same log entry (the device check, D-116). */
  differs?: DevicesDiffer | null;
  /** This device has saved no full backup for BACKUP_DUE_DAYS (`backupDue`): Budget → Needs attention says so. */
  backupDue?: boolean;
}

/** Why a sync starts from nothing; sent with the first request (`why`) and shown while it downloads. */
export type FullWhy =
  | 'memory' // this browser can't save anything (no IndexedDB)
  | 'first' // no saved copy on this phone yet
  | 'no_prf' // the passkey gave no key, so nothing can be saved
  | 'turned_off' // signed out from another device
  | 'unreadable_share'
  | 'unreadable_key'
  | 'unreadable_copy'
  | 'empty' // a saved copy with nothing in it
  | 'storage' // the saved copy couldn't be read from this device's storage (it's kept for the next time)
  | 'reset'; // the server's copy was restored, or a change made offline was refused
const MOCK = import.meta.env.VITE_MOCK === '1';

let state: CopyState = {
  status: MOCK ? 'off' : 'idle',
  saved: false,
  offline: false,
  progress: 0,
  why: null,
  error: null,
  queued: 0,
  hasSaved: false,
};

const listeners = createListeners();
/** Changes the copy's state; screens that use it render again. */
export function setCopy(patch: Partial<CopyState>): void {
  state = { ...state, ...patch };
  listeners.emit();
}

export function getCopy(): CopyState {
  return state;
}

export function useCopy(): CopyState {
  return useSyncExternalStore(listeners.subscribe, getCopy, getCopy);
}

/** Tests only: changes the state without telling anyone. */
export function patchCopyForTests(patch: Partial<CopyState>): void {
  state = { ...state, ...patch };
}

/** Screens refetch when the copy changes (the router subscribes and invalidates queries). */
const changes = createListeners();
export function onCopyChanged(fn: () => void): () => void {
  return changes.subscribe(fn);
}
/** Tells every screen the copy changed. */
export const copyChanged = (): void => changes.emit();
