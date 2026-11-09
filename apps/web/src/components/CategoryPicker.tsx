// The one way to choose a category: a sheet with search, your usual picks first, then every group with what
// each category has available. Activity uses the sheet directly (a tap categorizes at once); forms use
// CategoryField, a field-shaped button that opens the same sheet.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sheet, SheetTitle } from './Sheet';
import { cx, EmptyNote, Icon, inputClass, Label, SearchField } from './ui';
import { formatCents } from '../lib/money';
import { useCategoryOptions } from '../lib/common';

export interface PickerCategory {
  id: string;
  name: string;
  available?: number;
}
export interface PickerGroup {
  key: string;
  name: string;
  categories: PickerCategory[];
}
/** Choices that aren't categories, listed first: "Needs a category", "Ready to Assign", "Don’t set a category". */
export interface PickerSpecial {
  id: string;
  name: string;
}

/**
 * Call from the tap that opens the picker. iOS opens the keyboard only for a field focused during the tap
 * itself, and the picker's search field doesn't exist yet then. So this focuses a hidden stand-in field now;
 * the search field takes focus from it a moment later and the keyboard stays up.
 */
export function primeKeyboard() {
  if (!window.matchMedia?.('(pointer: coarse)').matches) return;
  const el = document.createElement('input');
  el.setAttribute('aria-hidden', 'true');
  el.tabIndex = -1;
  // Invisible; 16 px text so iOS doesn't zoom in on it.
  el.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
  document.body.appendChild(el);
  el.focus({ preventScroll: true });
  window.setTimeout(() => el.remove(), 1000);
}

const listBox = 'shrink-0 overflow-hidden rounded-lg border border-line';
const rowCls =
  'flex min-h-12 w-full items-center justify-between gap-3 border-t border-divider bg-surface px-3 text-left text-base text-ink first:border-t-0 disabled:text-disabled';

function Avail({ cents }: { cents: number | undefined }) {
  if (cents === undefined) return null;
  return (
    <span className={cx('tnum text-sm', cents < 0 ? 'text-over-fg' : 'text-muted')}>
      {formatCents(cents)}
    </span>
  );
}

export function CategoryPickerSheet({
  title = 'Choose a category',
  sub,
  groups,
  specials = [],
  suggestedTitle,
  suggested = [],
  suggestedCounts,
  value,
  onPick,
  onClose,
  disabled,
  modal,
  track,
  children,
}: {
  title?: string;
  sub?: ReactNode;
  groups: PickerGroup[];
  specials?: PickerSpecial[];
  suggestedTitle?: string;
  /** Category ids to offer first, e.g. what this payee usually gets. */
  suggested?: string[];
  /** How often each suggested category was used, shown next to its name. */
  suggestedCounts?: Record<string, number>;
  value?: string;
  onPick: (id: string) => void;
  onClose: () => void;
  disabled?: boolean;
  modal?: boolean;
  track: string;
  /** Extra actions under the list (Split it…, It’s a transfer…). */
  children?: ReactNode;
}) {
  const [q, setQ] = useState('');
  const search = useRef<HTMLInputElement>(null);
  // Start in the search field, so you can type at once.
  useLayoutEffect(() => {
    search.current?.focus({ preventScroll: true });
  }, []);
  const all = useMemo(
    () => groups.flatMap((g) => g.categories.map((c) => ({ ...c, group: g.name }))),
    [groups],
  );
  const byId = useMemo(() => new Map(all.map((c) => [c.id, c])), [all]);
  const needle = q.trim().toLowerCase();
  const matches = needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : [];
  // "Ready to Assign" or "Owed to you" are found by a search too.
  const specialMatches = needle ? specials.filter((sp) => sp.name.toLowerCase().includes(needle)) : [];
  const usual = suggested.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => !!c);
  const pick = (id: string) => () => onPick(id);
  const row = (c: PickerCategory & { group?: string }, how: string, showGroup = false) => (
    <button
      key={c.id}
      type="button"
      disabled={disabled}
      data-track={`${track}.${how}`}
      aria-pressed={value === undefined ? undefined : value === c.id}
      onClick={pick(c.id)}
      className={rowCls}
    >
      <span className="flex min-w-0 items-center gap-2">
        {value === c.id && <Icon name="check" size={16} stroke={2.6} className="shrink-0 text-accent" />}
        <span className="truncate">{c.name}</span>
        {showGroup && c.group && <span className="shrink-0 text-sm text-muted">· {c.group}</span>}
      </span>
      <Avail cents={c.available} />
    </button>
  );

  return (
    <Sheet
      label={title}
      track={track}
      onClose={onClose}
      gap="small"
      modal={modal}
      closeLabel="Close category picker"
      header={<SheetTitle title={title} sub={sub} />}
    >
      <div className="flex flex-col gap-2.5 pb-4">
        {/* SearchField takes no data-track; the tracker reads the nearest one, so the wrapper carries it. */}
        <div data-track={`${track}.search`} className="flex shrink-0 flex-col">
          <SearchField
            ref={search}
            value={q}
            onChange={setQ}
            label="Search categories"
            placeholder="Search categories"
          />
        </div>
        {needle ? (
          matches.length + specialMatches.length > 0 ? (
            <div className={listBox}>
              {specialMatches.map((sp) => row(sp, 'special'))}
              {matches.map((c) => row(c, 'search_result', true))}
            </div>
          ) : (
            <EmptyNote>No category called “{q.trim()}”.</EmptyNote>
          )
        ) : (
          <>
            {usual.length > 0 && (
              <>
                <Label>{suggestedTitle ?? 'Usually'}</Label>
                <div className="flex flex-wrap gap-2">
                  {usual.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      disabled={disabled}
                      data-track={`${track}.suggested`}
                      onClick={pick(c.id)}
                      className="hit flex h-10 items-center gap-2 rounded-full border border-accent bg-accent-soft px-3.5 text-md font-bold text-accent"
                    >
                      {c.name}
                      {suggestedCounts?.[c.id] !== undefined && (
                        <span className="tnum font-normal text-muted">
                          {suggestedCounts[c.id]}×<span className="sr-only"> before</span>
                        </span>
                      )}
                      {c.available !== undefined && c.available < 0 && (
                        <span className="tnum font-semibold text-over-fg">{formatCents(c.available)}</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
            {specials.length > 0 && <div className={listBox}>{specials.map((sp) => row(sp, 'special'))}</div>}
            {groups.map((g) => (
              <div key={g.key} className="flex flex-col gap-2.5">
                <span className="pt-1">
                  <Label>{g.name}</Label>
                </span>
                <div className={listBox}>{g.categories.map((c) => row(c, 'category'))}</div>
              </div>
            ))}
          </>
        )}
        {children}
      </div>
    </Sheet>
  );
}

/**
 * A form field that shows the chosen category and opens the picker. Wrap it in <Field label="Category"> (or
 * point a <label htmlFor> at `id`) so it's named like any other field.
 */
export function CategoryField({
  id,
  value,
  onChange,
  specials = [],
  groups: given,
  placeholder = 'Choose…',
  title,
  sub,
  track,
  ariaLabel,
  valueName,
}: {
  id?: string;
  value: string;
  /** The name to show for a value the list doesn't hold (a category archived since it was picked). */
  valueName?: string | null;
  onChange: (id: string) => void;
  specials?: PickerSpecial[];
  /** Defaults to every category you can pick. */
  groups?: PickerGroup[];
  placeholder?: string;
  title?: string;
  sub?: ReactNode;
  track: string;
  ariaLabel?: string;
}) {
  const opts = useCategoryOptions();
  const groups =
    given ??
    opts.groups.map((g) => ({
      key: g.id,
      name: g.name,
      categories: g.categories,
    }));
  const [open, setOpen] = useState(false);
  const cat = groups.flatMap((g) => g.categories).find((c) => c.id === value);
  const chosen: PickerCategory | undefined = specials.find((s) => s.id === value) ?? cat;
  const avail = cat?.available;
  return (
    <>
      <button
        id={id}
        type="button"
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        data-track={`${track}.open`}
        onClick={() => {
          primeKeyboard();
          setOpen(true);
        }}
        className={cx(inputClass, 'flex items-center justify-between gap-2 text-left')}
      >
        <span className={cx('truncate', !chosen && !valueName && 'text-faint')}>
          {chosen ? chosen.name : value && valueName ? valueName : placeholder}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted">
          <Avail cents={avail} />
          <Icon name="chevR" size={18} />
        </span>
      </button>
      {open && (
        <CategoryPickerSheet
          modal
          title={title}
          sub={sub}
          groups={groups}
          specials={specials}
          value={value}
          track={track}
          onPick={(v) => {
            onChange(v);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
