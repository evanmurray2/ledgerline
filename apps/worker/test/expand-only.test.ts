// The expand-only rule for Durable Object migrations (docs/multi-user.md 5.7): a rollback restores old code, not the
// old schema, so a new migration may add but never drop or rename (tools/ci/migration-check.mjs).
import { describe, expect, it } from 'vitest';
import { nonExpanding } from '../../../tools/ci/expand-only.mjs';

describe('expand-only migrations', () => {
  it('allows adding tables, columns and indexes', () => {
    expect(
      nonExpanding('ALTER TABLE job ADD COLUMN note TEXT;\nCREATE INDEX job_kind ON job(kind);'),
    ).toEqual([]);
    expect(nonExpanding('-- never drop or rename\nCREATE TABLE t (a INTEGER);')).toEqual([]);
  });

  it('refuses drops and renames', () => {
    expect(nonExpanding('DROP TABLE alert;')).toEqual(['DROP']);
    expect(nonExpanding('drop index job_due;')).toEqual(['DROP']);
    expect(nonExpanding('ALTER TABLE job DROP COLUMN note;')).toEqual(['ALTER TABLE … DROP COLUMN']);
    expect(nonExpanding('ALTER TABLE job RENAME TO jobs;')).toEqual(['ALTER TABLE … RENAME']);
  });

  it('allows a removal marked as the second release of a two-step removal', () => {
    expect(nonExpanding('-- expand-only: removal of alert, unused since abc1234\nDROP TABLE alert;')).toEqual(
      [],
    );
  });
});
