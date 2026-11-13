// The privacy policy page reads docs/privacy-policy.md (lib/policy.ts), and a change to that file is deployed.
import { describe, expect, it } from 'vitest';
import { inline, parsePolicy } from '../src/lib/policy';
import { docsOnly } from '../../../tools/ci/scope.mjs';
import policyText from '../../../docs/privacy-policy.md?raw';

const MD = `# Privacy policy (draft)

Notes for the owner.

---

Last changed: today.

## Short

- **(owner reads)** One line
  that wraps.
- **(later)** Not built.
- Two, see https://my.plaid.com.

**(later)** A paragraph not true yet.

| What | Who |
| ---- | --- |
| **(owner reads)** Budget | \`you\` |
`;

describe('the policy', () => {
  it('drops the notes, the review marks and what is not true yet', () => {
    const p = parsePolicy(MD);
    expect(p).toMatchObject({ title: 'Privacy policy', draft: true });
    expect(p.blocks).toEqual([
      { kind: 'p', parts: [{ kind: 'text', text: 'Last changed: today.' }] },
      { kind: 'h2', text: 'Short' },
      {
        kind: 'ul',
        items: [
          [{ kind: 'text', text: 'One line that wraps.' }],
          [
            { kind: 'text', text: 'Two, see ' },
            { kind: 'link', text: 'https://my.plaid.com' },
            { kind: 'text', text: '.' },
          ],
        ],
      },
      {
        kind: 'table',
        head: [[{ kind: 'text', text: 'What' }], [{ kind: 'text', text: 'Who' }]],
        rows: [[[{ kind: 'text', text: 'Budget' }], [{ kind: 'code', text: 'you' }]]],
      },
    ]);
  });

  it('reads bold text', () => {
    expect(inline('a **b** c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' c' },
    ]);
  });

  it('the real policy has its sections, and none of the notes', () => {
    const p = parsePolicy(policyText);
    const heads = p.blocks.flatMap((b) => (b.kind === 'h2' ? [b.text] : []));
    expect(heads).toContain('The short version');
    expect(heads).toContain('Contact');
    expect(JSON.stringify(p.blocks)).not.toMatch(/owner reads|\(later\)|Status: a draft/);
  });

  it('is shipped: a change to it alone is not a docs-only change', () => {
    expect(docsOnly(['docs/privacy-policy.md'])).toBe(false);
    expect(docsOnly(['docs/privacy.md', 'README.md'])).toBe(true);
  });
});
