// The Worker type-checks against its own copy of this package's types (apps/worker/src/types/seal.d.ts), since the
// package's sources don't type-check under Cloudflare's WebCrypto types. This checks that copy field for field
// against the package: each shape here must be the same both ways, or `pnpm typecheck` fails.
import { describe, expect, it } from 'vitest';
import type * as W from '../../../apps/worker/src/types/seal.js';
import type { ChainState, PublicState } from '../src/chain.js';
import { KIND, type Entry, type EntryFields, type EntryHeader, type Kind } from '../src/entry.js';
import type { RunManifest } from '../src/run.js';
import type { SlotRecord } from '../src/slots.js';
import type { Manifest, SealedSnapshot, SnapshotBounds, SnapshotHeader } from '../src/snapshot.js';

/** True only when A and B are the same type (each assignable to the other, with no `any`). */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <T extends true>(): T => true as T;

describe("the Worker's copy of the package's types", () => {
  it('matches the entry, the chain, slots, runs and snapshots', () => {
    same<Same<W.Kind, Kind>>();
    same<Same<W.EntryHeader, EntryHeader>>();
    same<Same<W.EntryFields, EntryFields>>();
    same<Same<W.Entry, Entry>>();
    same<Same<W.SlotRecord, SlotRecord>>();
    same<Same<W.PublicState, PublicState>>();
    same<Same<Omit<W.ChainState, 'public' | 'pending'>, Omit<ChainState, 'public' | 'pending'>>>();
    same<Same<W.RunManifest, RunManifest>>();
    same<Same<W.SnapshotHeader, SnapshotHeader>>();
    same<Same<W.SnapshotManifest, Manifest>>();
    same<Same<W.SealedSnapshot, SealedSnapshot>>();
    same<Same<W.SnapshotBounds, SnapshotBounds>>();
    // The kinds' values too.
    const kinds: Record<keyof typeof KIND, W.Kind> = KIND;
    expect(Object.keys(kinds)).toHaveLength(10);
  });
});
