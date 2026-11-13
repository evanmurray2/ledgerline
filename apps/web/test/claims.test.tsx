// Settings → Privacy → What Ledgerline claims (docs/privacy.md phase 8, docs/claims.md): every claim of section 1.1
// with its state, its limit and how it is backed, and nothing claimed that the code doesn't do yet.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLAIMS, ClaimList, NOT_BUILT, STATE_WORD } from '../src/screens/settings/Claims';

afterEach(cleanup);

const byId = (id: string) => CLAIMS.find((c) => c.id === id)!;

describe('the claims', () => {
  it('lists the nine claims of docs/privacy.md 1.1, each with a limit', () => {
    expect(CLAIMS.map((c) => c.id)).toEqual([
      'key',
      'no-copy',
      'bank-data',
      'bank-key',
      'no-trackers',
      'sign-up',
      'delete',
      'idle',
      'public-code',
    ]);
    for (const c of CLAIMS) expect(c.limit.length).toBeGreaterThan(0);
  });

  it('claims only what the code does today', () => {
    // The readable copy from before the lock is dropped (D-106), but Cloudflare's 30-day history still holds it.
    expect(byId('no-copy').state).toBe('partly');
    // Bank data since the lock is sealed at once; what came before was in that copy.
    expect(byId('bank-data').state).toBe('partly');
    // Removing a bank at Plaid and the idle job are not built.
    expect(byId('delete').state).toBe('not_yet');
    expect(byId('idle').state).toBe('not_yet');
    expect(byId('key').state).toBe('true');
    expect(byId('public-code').state).toBe('true');
  });

  it('marks as Ledgerline’s word exactly what docs/privacy.md 1.1 does', () => {
    const word = CLAIMS.filter((c) => c.check === null).map((c) => c.id);
    expect(word).toEqual(['no-copy', 'bank-data', 'bank-key', 'delete', 'idle']);
  });

  it('says what it says about outside code only while the app’s policy allows none', () => {
    const headers = readFileSync(resolve(__dirname, '../public/_headers'), 'utf8');
    const csp = /Content-Security-Policy: (.*)/.exec(headers)![1]!;
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toMatch(/https?:/);
  });

  it('uses the app’s words: locked, not sealed or encrypted, and no “we”', () => {
    const all = [
      ...CLAIMS.flatMap((c) => [c.text, c.limit, c.check ?? '']),
      ...NOT_BUILT.flatMap((n) => [n.name, n.text]),
    ].join(' ');
    expect(all).not.toMatch(/\b(sealed|encrypted|end-to-end|zero-knowledge)\b/i);
    expect(all).not.toMatch(/\b(we|our|us)\b/i);
  });
});

describe('Settings → Privacy → What Ledgerline claims', () => {
  it('shows each claim with its state and how it is backed, and the limit behind a tap', () => {
    render(<ClaimList locked />);
    for (const c of CLAIMS) expect(screen.getByText(c.text)).toBeTruthy();
    expect(screen.getAllByText(`${STATE_WORD.true}.`)).toHaveLength(5);
    expect(screen.getAllByText(`${STATE_WORD.not_yet}.`)).toHaveLength(2);
    expect(screen.getAllByText(`${STATE_WORD.partly}.`)).toHaveLength(2);
    expect(screen.getAllByText(/Ledgerline’s word: nobody outside can check it\./)).toHaveLength(5);
    expect(screen.queryByText(byId('no-copy').limit)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'What is the limit?' })[1]!);
    expect(screen.getByText(byId('no-copy').limit)).toBeTruthy();
    expect(screen.getByText('Sign in with your recovery key')).toBeTruthy();
    expect(screen.queryByText('Your budget isn’t locked yet')).toBeNull();
  });

  it('says the claims are about a locked budget when this one isn’t locked', () => {
    render(<ClaimList locked={false} />);
    expect(screen.getByText('Your budget isn’t locked yet')).toBeTruthy();
  });
});
