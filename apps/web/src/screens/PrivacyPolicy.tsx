// /privacy-policy: the privacy policy, read from docs/privacy-policy.md (lib/policy.ts). Shown before any sign-in
// check (router.tsx), so it opens from Sign in and Create account as well as from Settings.
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import policyText from '../../../../docs/privacy-policy.md?raw';
import { BackHeader } from '../components/headers';
import { parsePolicy, type Block, type Inline } from '../lib/policy';
import { backLabel, useBack } from '../lib/back';

const policy = parsePolicy(policyText);

function Text({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'bold' ? (
          <strong key={i} className="font-semibold text-ink">
            {p.text}
          </strong>
        ) : p.kind === 'code' ? (
          <code key={i}>{p.text}</code>
        ) : p.kind === 'link' ? (
          <a key={i} href={p.text} target="_blank" rel="noopener noreferrer" className="text-accent">
            {p.text}
          </a>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

function Part({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case 'h2':
      return <h2 className="m-0 mt-3 text-xl font-bold text-ink">{block.text}</h2>;
    case 'h3':
      return <h3 className="m-0 mt-2 text-lg font-bold text-ink">{block.text}</h3>;
    case 'p':
      return (
        <p className="m-0">
          <Text parts={block.parts} />
        </p>
      );
    case 'ul':
      return (
        <ul className="m-0 flex flex-col gap-2 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>
              <Text parts={item} />
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {block.head.map((c, i) => (
                  <th key={i} className="border-b border-line px-3 py-2 text-left font-semibold text-ink">
                    <Text parts={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className="border-t border-divider px-3 py-2 align-top">
                      <Text parts={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function PrivacyPolicyScreen() {
  const navigate = useNavigate();
  // Opened from Settings or Sign in (?back=…); otherwise Back goes to the app, which shows Sign in when signed out.
  const ret = useBack();
  return (
    <main className="flex min-h-dvh flex-col bg-page text-ink">
      <BackHeader
        title={policy.title}
        sub={policy.draft ? 'Draft' : undefined}
        onBack={ret ? ret.go : () => void navigate({ to: '/budget' })}
        backLabel={ret?.label ?? backLabel('/budget')}
      />
      <div className="flex w-full max-w-[680px] flex-col gap-3 self-center px-4 pb-10 pt-3 text-base leading-relaxed text-ink-2">
        {policy.blocks.map((b, i) => (
          <Part key={i} block={b} />
        ))}
      </div>
    </main>
  );
}
