// The payee box of a transaction you add: as you type, it lists your payees that match, and a tap (or the arrow
// keys and Enter) fills the name in. Any other name is fine too: an entry of yours has only a name.
import { useId, useMemo, useState } from 'react';
import { cx, inputClass } from './ui';

const norm = (s: string) => s.trim().replace(/[’‘]/g, "'").toLowerCase();

/**
 * Up to `max` of `names` that match what's typed: names that start with it first, then names with a word that
 * starts with it, each in the order given (most used first). Nothing for an empty box or a name typed in full.
 */
export function matchPayees(names: string[], typed: string, max = 5): string[] {
  const needle = norm(typed);
  if (!needle) return [];
  const starts: string[] = [];
  const words: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const n = norm(name);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (n === needle) continue;
    if (n.startsWith(needle)) starts.push(name);
    else if (n.split(/\s+/).some((w) => w.startsWith(needle))) words.push(name);
  }
  return [...starts, ...words].slice(0, max);
}

export function PayeeField({
  id,
  value,
  onChange,
  names,
  placeholder,
  track,
}: {
  /** Point a <label htmlFor> at it: the list of names sits outside the label, so it isn't read as part of it. */
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** Your payees' names, most used first. */
  names: string[];
  placeholder?: string;
  track: string;
}) {
  const listId = useId();
  // Closed after a pick or Escape, until you type again.
  const [closed, setClosed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const matches = useMemo(() => matchPayees(names, value), [names, value]);
  const open = focused && !closed && matches.length > 0;
  const pick = (name: string) => {
    onChange(name);
    setClosed(true);
    setActive(-1);
  };
  return (
    <>
      <input
        id={id}
        className={inputClass}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoCorrect="off"
        placeholder={placeholder}
        maxLength={120}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setClosed(false);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            setActive((a) => (a + step + matches.length + (a < 0 && step < 0 ? 1 : 0)) % matches.length);
          } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault();
            pick(matches[active]!);
          } else if (e.key === 'Escape') {
            // Closes the list only; a second Escape closes the sheet.
            e.stopPropagation();
            setClosed(true);
          }
        }}
      />
      <div
        id={listId}
        role="listbox"
        aria-label="Matching names"
        hidden={!open}
        className="shrink-0 overflow-hidden rounded-lg border border-line"
      >
        {open &&
          matches.map((name, i) => (
            <div
              key={name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              data-track={`${track}.suggestion`}
              // The box keeps focus (and the phone its keyboard) when a name is tapped.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(name)}
              className={cx(
                'flex min-h-12 cursor-pointer items-center border-t border-divider px-3 text-base font-normal text-ink first:border-t-0',
                i === active ? 'bg-sunken' : 'bg-surface',
              )}
            >
              <span className="truncate">{name}</span>
            </div>
          ))}
      </div>
    </>
  );
}
