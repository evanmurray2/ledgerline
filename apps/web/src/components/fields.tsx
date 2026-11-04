// Form parts: the label, the text box, a labelled field, the on/off switch and the search box.
import { forwardRef, type ReactNode } from 'react';
import { useDisabled } from './buttons';
import { cx, Icon } from './ui';

export function Label({ children }: { children: ReactNode }) {
  return <span className="text-[12px] font-bold uppercase tracking-[0.4px] text-ink-2">{children}</span>;
}

export const inputClass =
  'h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3 text-[16px] text-ink placeholder:text-faint disabled:bg-sunken disabled:text-muted';

export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2', className)}>
      {label}
      {children}
    </label>
  );
}

export function Toggle({
  label,
  help,
  checked,
  onChange,
  track,
  mutates,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  track?: string;
  mutates?: boolean;
}) {
  const off = useDisabled(mutates, false);
  return (
    <label className="flex min-h-14 items-center justify-between gap-3 border-t border-divider px-3 py-2 text-[15px] font-semibold first:border-t-0">
      <span className="flex flex-col gap-px">
        {label}
        {help && <span className="text-[12px] font-normal text-muted">{help}</span>}
      </span>
      {/* An on/off setting reads as a switch; checkboxes are kept for picking items from a list. */}
      <input
        type="checkbox"
        role="switch"
        className={cx(
          'hit relative h-7 w-12 shrink-0 cursor-pointer appearance-none rounded-full transition-colors',
          "before:absolute before:left-[3px] before:top-[3px] before:h-[22px] before:w-[22px] before:rounded-full before:bg-surface before:shadow-[0_1px_2px_var(--ll-shadow)] before:transition-transform before:content-['']",
          'checked:bg-accent checked:before:translate-x-5 disabled:cursor-not-allowed disabled:opacity-50',
          checked ? '' : 'bg-faint',
        )}
        checked={checked}
        disabled={off}
        data-track={track}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** The one search box: icon, type="search", Escape clears it. */
export const SearchField = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (v: string) => void;
    label: string;
    placeholder: string;
    shortcut?: string;
    className?: string;
  }
>(function SearchField({ value, onChange, label, placeholder, shortcut, className }, ref) {
  return (
    <label
      className={cx(
        'flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-sunken px-3 text-muted',
        className,
      )}
    >
      <Icon name="search" size={18} />
      <span className="sr-only">{label}</span>
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && value && (e.stopPropagation(), onChange(''))}
        placeholder={placeholder}
        aria-keyshortcuts={shortcut}
        className="min-h-10 min-w-0 flex-1 border-none bg-transparent text-[16px] text-ink outline-none placeholder:text-faint"
      />
    </label>
  );
});
