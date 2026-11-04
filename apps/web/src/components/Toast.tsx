// One toast at a time, with optional Undo and a second line offering an action (the "Always" rule offer).
import { useEffect, useSyncExternalStore } from 'react';
import { cx, useIsDesktop } from './ui';
import { useCanWrite } from '../state/connectivity';

export interface ToastSpec {
  text: string;
  undo?: () => void | Promise<void>;
  offer?: { text: string; label: string; onAccept: () => void | Promise<void>; onIgnore?: () => void };
  ms?: number;
}

interface Live extends ToastSpec {
  id: number;
}

let current: Live | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const toast = {
  show(spec: ToastSpec) {
    if (current?.offer?.onIgnore) current.offer.onIgnore();
    seq += 1;
    current = { ...spec, id: seq };
    emit();
    return seq;
  },
  update(id: number, patch: Partial<ToastSpec>) {
    if (current?.id !== id) return;
    current = { ...current, ...patch };
    emit();
  },
  dismiss(id?: number) {
    if (id !== undefined && current?.id !== id) return;
    current = null;
    emit();
  },
  get: () => current,
};

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function ToastHost({ aboveTabs }: { aboveTabs: boolean }) {
  const t = useSyncExternalStore(subscribe, toast.get, toast.get);
  const desktop = useIsDesktop();
  const canWrite = useCanWrite();

  useEffect(() => {
    if (!t) return;
    const ms = t.ms ?? (t.offer ? 10_000 : 6_000);
    const id = setTimeout(() => {
      if (toast.get()?.id === t.id) {
        t.offer?.onIgnore?.();
        toast.dismiss(t.id);
      }
    }, ms);
    return () => clearTimeout(id);
  }, [t]);

  if (!t) return null;
  return (
    <div
      role="status"
      className={cx(
        'fixed z-50 flex flex-col gap-1.5 rounded-lg bg-inverse px-3 py-2.5 text-on-inverse shadow-raised',
        desktop
          ? 'bottom-6 right-6 w-[380px]'
          : cx(
              'left-4 right-4',
              aboveTabs ? 'bottom-[calc(88px+env(safe-area-inset-bottom,0px))]' : 'bottom-6',
            ),
      )}
    >
      <div className="flex items-center justify-between gap-2 text-md">
        <span>{t.text}</span>
        {t.undo && (
          <button
            type="button"
            data-track="toast.undo"
            disabled={!canWrite}
            className="hit h-9 shrink-0 px-2 text-md font-bold underline disabled:opacity-50"
            onClick={async () => {
              const u = t.undo!;
              toast.dismiss(t.id);
              await u();
            }}
          >
            Undo
          </button>
        )}
      </div>
      {t.offer && (
        <div className="flex items-center justify-between gap-2 border-t border-inverse-line pt-1.5 text-sm text-inverse-muted">
          <span>{t.offer.text}</span>
          <button
            type="button"
            data-track="toast.always"
            disabled={!canWrite}
            className="hit h-9 shrink-0 rounded-full bg-on-inverse px-3 text-sm font-bold text-inverse disabled:opacity-50"
            onClick={() => void t.offer!.onAccept()}
          >
            {t.offer.label}
          </button>
        </div>
      )}
    </div>
  );
}
