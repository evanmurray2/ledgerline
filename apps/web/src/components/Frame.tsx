// The frame of the screens shown before the app opens (sign-in, adding a device, the locked copy): the Ledgerline
// label, a 26 px title and a narrow column on the page background. Problem shows what went wrong in it.
import { type ReactNode } from 'react';
import { ErrorNote } from './ui';

export function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
      <div className="flex w-full max-w-[400px] flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-bold uppercase tracking-[0.5px] text-accent">Ledgerline</span>
          <h1 className="m-0 text-[26px] font-bold text-ink">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

/** A sentence about what went wrong, drawn as the app's ErrorNote. Nothing when there's no problem. */
export function Problem({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return <ErrorNote error={new Error(text)} />;
}
