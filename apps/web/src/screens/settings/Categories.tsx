// Settings → Categories: the categories page under Budget, groups, drag to reorder, the category sheet (D-35).
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link, Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { type CategoriesView } from '@ledgerline/contracts';
import { api } from '../../api/endpoints';
import { qk, useCategoriesSettings, useMoneyMutation } from '../../api/hooks';
import { Sheet } from '../../components/Sheet';
import { moved, useReorder } from '../../components/reorder';
import { toast } from '../../components/Toast';
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Icon,
  inputClass,
  Loading,
  PrimaryButton,
  SecondaryButton,
  Segmented,
  Toggle,
} from '../../components/ui';
import { formatCents } from '../../lib/money';
import { useScreen } from '../../lib/common';
import { usage } from '../../usage/tracker';
import { useCanWrite } from '../../state/connectivity';
import { Page } from './common';

// ------------------------------------------------------------------ categories

export function CategoriesScreen() {
  useScreen('settings.categories');
  const q = useCategoriesSettings();
  const archive = useMoneyMutation(
    (v: { id: string; archived: boolean }) => api.archiveCategory(v.id, v.archived),
    { invalidate: [qk.categories] },
  );
  const [showArchived, setShowArchived] = useState(false);
  const v = q.data;
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.categories });
    void qc.invalidateQueries({ queryKey: ['budget'] });
  };
  const fail = (e: unknown) => {
    refresh();
    toast.show({ text: e instanceof Error ? e.message : 'Couldn’t save that. Try again.' });
  };
  const mine = (v?.groups ?? []).filter((g) => !g.system);
  /** Shows a new order at once; the save follows, and a failure reloads the list as it was. */
  const show = (next: typeof mine) =>
    qc.setQueryData<CategoriesView>(qk.categories, (old) =>
      old ? { ...old, groups: [...old.groups.filter((g) => g.system), ...next] } : old,
    );
  const moveGroup = (from: number, to: number) => {
    if (!canWrite) return;
    const next = moved(mine, from, to);
    show(next);
    api.reorderGroups(next.map((g) => g.id)).then(refresh, fail);
  };
  /** The server keeps one order for all categories, so the whole list is sent. */
  const moveCategory = (groupId: string, from: number, to: number) => {
    if (!canWrite) return;
    const next = mine.map((g) =>
      g.id === groupId ? { ...g, categories: moved(g.categories, from, to) } : g,
    );
    show(next);
    api.reorderCategories(next.flatMap((g) => g.categories.map((c) => c.id))).then(refresh, fail);
  };
  const groups = useReorder(mine.length, moveGroup);
  const doArchive = async (id: string, name: string, archived: boolean) => {
    try {
      await archive.mutateAsync({ id, archived });
    } catch (e) {
      toast.show({ text: e instanceof Error ? e.message : 'Couldn’t save that.' });
      return;
    }
    toast.show({
      text: `${name} ${archived ? 'archived' : 'restored'}`,
      undo: async () => {
        await archive.mutateAsync({ id, archived: !archived });
        usage.undo(archived ? 'archive' : 'restore');
      },
    });
  };
  return (
    <Page title="Categories" back="/budget">
      {!v && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {v && (
        <p className="m-0 text-[13px] text-muted">
          Tap a name to change or remove it. Drag the handles to reorder.
        </p>
      )}
      {/* Card payment categories are made by the app and can't be edited, so this screen leaves them out. */}
      {mine.map((g, gi) => (
        <GroupSection
          key={g.id}
          g={g}
          sectionRef={groups.itemRef(gi)}
          style={groups.itemStyle(gi)}
          handle={
            <DragHandle
              label={`Reorder group ${g.name}`}
              disabled={!canWrite || mine.length < 2}
              props={groups.handleProps(gi)}
            />
          }
          onMoveCategory={moveCategory}
          canWrite={canWrite}
        />
      ))}
      {v && (
        <Link
          to="/categories/new-group"
          data-track="categories.add_group"
          className="flex h-11 shrink-0 items-center justify-center rounded-xl border border-dashed border-accent text-[14px] font-bold text-accent no-underline"
        >
          + Group
        </Link>
      )}
      {v && v.archived.length > 0 && (
        <>
          <button
            type="button"
            data-track="categories.show_archived"
            onClick={() => setShowArchived(!showArchived)}
            className="min-h-9 self-start text-[14px] font-bold text-accent"
          >
            {showArchived ? 'Hide archived' : `Show archived (${v.archived.length})`}
          </button>
          {showArchived && (
            <Card>
              {v.archived.map((a) => (
                <div
                  key={a.id}
                  className="flex min-h-14 items-center justify-between gap-2 border-t border-divider px-3 first:border-t-0"
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[15px] font-semibold">{a.name}</span>
                    <span className="text-[12px] text-muted">{a.meta}</span>
                  </span>
                  <Button
                    mutates
                    track="categories.restore"
                    onClick={() => void doArchive(a.id, a.name, false)}
                    className="hit h-9 rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent"
                  >
                    Restore
                  </Button>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
      <Outlet />
    </Page>
  );
}

/** The ≡ handle: drag it, or focus it and press the up or down arrow. */
function DragHandle({
  label,
  disabled,
  props,
}: {
  label: string;
  disabled: boolean;
  props: ReturnType<ReturnType<typeof useReorder>['handleProps']>;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Drag to reorder, or use the arrow keys"
      disabled={disabled}
      data-track="categories.reorder"
      className="flex h-11 w-9 shrink-0 cursor-grab touch-none items-center justify-center text-faint disabled:invisible"
      {...(disabled ? {} : props)}
    >
      <Icon name="grip" size={20} />
    </button>
  );
}

type CatGroup = CategoriesView['groups'][number];

function GroupSection({
  g,
  sectionRef,
  style,
  handle,
  onMoveCategory,
  canWrite,
}: {
  g: CatGroup;
  sectionRef: (el: HTMLElement | null) => void;
  style: CSSProperties | undefined;
  handle: ReactNode;
  onMoveCategory: (groupId: string, from: number, to: number) => void;
  canWrite: boolean;
}) {
  const rows = useReorder(g.categories.length, (from, to) => onMoveCategory(g.id, from, to));
  return (
    <section ref={sectionRef} style={style} className="flex shrink-0 flex-col gap-1.5 rounded-[14px] bg-page">
      <div className="flex min-h-11 items-center gap-1">
        {handle}
        <Link
          to={`/categories/group:${g.id}`}
          data-track="categories.rename_group"
          aria-label={`Rename group ${g.name}`}
          className="flex min-h-11 min-w-0 flex-1 items-center no-underline"
        >
          <h2 className="m-0 truncate text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">
            {g.name}
          </h2>
        </Link>
        <span className="pr-0.5 text-[12px] text-muted">{g.categories.length}</span>
      </div>
      <Card>
        {g.categories.length === 0 && (
          <p className="m-0 px-3 py-3 text-[13px] text-muted">No categories yet.</p>
        )}
        {g.categories.map((c, ci) => (
          <div
            key={c.id}
            ref={rows.itemRef(ci)}
            style={rows.itemStyle(ci)}
            className="flex min-h-14 items-center gap-1 border-t border-divider bg-surface pl-1 pr-3 first:border-t-0"
          >
            <DragHandle
              label={`Reorder ${c.name}`}
              disabled={!canWrite || g.categories.length < 2}
              props={rows.handleProps(ci)}
            />
            <Link
              to={`/categories/${c.id}`}
              data-track="categories.open"
              className="flex min-w-0 flex-1 flex-col gap-0.5 py-2 text-ink no-underline"
            >
              <span className="text-[15px] font-semibold">{c.name}</span>
              <span className="truncate text-[12px] text-muted">{c.meta}</span>
            </Link>
          </div>
        ))}
        <Link
          to="/categories/new"
          search={{ group: g.id }}
          data-track="categories.add"
          className="flex min-h-12 items-center gap-1.5 border-t border-divider px-3 text-[14px] font-bold text-accent no-underline first:border-t-0"
        >
          <Icon name="plus" size={16} stroke={2.6} />
          Add category
        </Link>
      </Card>
    </section>
  );
}

export function CategoryEditSheet() {
  const { categoryId } = useParams({ strict: false }) as { categoryId: string };
  const groupEditId = categoryId.startsWith('group:') ? categoryId.slice(6) : null;
  const isGroup = categoryId === 'new-group' || groupEditId !== null;
  const isNew = categoryId === 'new' || categoryId === 'new-group';
  useScreen(isGroup ? 'settings.group.new' : isNew ? 'settings.category.new' : 'settings.category.edit');
  const q = useCategoriesSettings();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const close = () => void navigate({ to: '/categories' });
  // "Add category" at the end of a group opens this with that group chosen.
  const fromGroup = (useSearch({ strict: false }) as { group?: string }).group;
  const [asking, setAsking] = useState(false);
  const existing = q.data?.groups
    .flatMap((g) => g.categories.map((c) => ({ ...c, groupId: g.id })))
    .find((c) => c.id === categoryId);
  const groups = (q.data?.groups ?? []).filter((g) => !g.system);
  const editingGroup = groupEditId ? groups.find((x) => x.id === groupEditId) : undefined;
  const [name, setName] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [kind, setKind] = useState<'spending' | 'saving' | null>(null);
  const [isBills, setIsBills] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canWrite = useCanWrite();
  const n = name ?? existing?.name ?? editingGroup?.name ?? '';
  const bills = isBills ?? editingGroup?.isBills ?? false;
  const g =
    groupId ??
    existing?.groupId ??
    (fromGroup && groups.some((x) => x.id === fromGroup) ? fromGroup : undefined) ??
    groups[0]?.id ??
    '';
  const k = kind ?? (existing?.kind === 'saving' ? 'saving' : 'spending');
  const save = async (thenTarget = false) => {
    setBusy(true);
    setError(null);
    try {
      let newId: string | null = null;
      if (isGroup) await api.upsertGroup({ id: groupEditId ?? undefined, name: n.trim(), isBills: bills });
      else
        newId = (
          await api.upsertCategory({
            id: isNew ? undefined : categoryId,
            name: n.trim(),
            groupId: g || null,
            kind: k,
          })
        ).id;
      await qc.invalidateQueries({ queryKey: qk.categories });
      void qc.invalidateQueries({ queryKey: ['budget'] });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      if (thenTarget && newId)
        void navigate({ to: `/budget/category/${newId}/target`, search: { from: 'categories' } });
      else close();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  /** Deleted when never used; otherwise archived (with Undo), so history and reports keep it. */
  const remove = async () => {
    if (!existing) return;
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: qk.categories });
      void qc.invalidateQueries({ queryKey: ['budget'] });
    };
    try {
      const r = await api.removeCategory(existing.id);
      refresh();
      if (r.outcome === 'deleted') toast.show({ text: `${existing.name} deleted` });
      else
        toast.show({
          text: `${existing.name} archived: it has history, so reports keep it`,
          undo: async () => {
            await api.archiveCategory(existing.id, false);
            usage.undo('archive');
            refresh();
          },
        });
      close();
    } catch (e) {
      setError(e);
    }
  };
  const title = groupEditId
    ? 'Rename group'
    : isGroup
      ? 'New group'
      : isNew
        ? 'New category'
        : 'Edit category';
  return (
    <Sheet
      label={title}
      track="category_edit"
      onClose={close}
      gap="auto"
      header={<h1 className="m-0 text-[20px] font-bold">{title}</h1>}
    >
      <div className="flex flex-col gap-3.5 pb-4">
        <Field label="Name">
          <input
            className={inputClass}
            value={n}
            maxLength={60}
            placeholder={isGroup ? 'e.g. Kids' : 'e.g. Climbing'}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {isGroup ? (
          <Toggle
            label="Bills group"
            help="Bills are never shown as Low"
            checked={bills}
            onChange={setIsBills}
          />
        ) : (
          <>
            <Field label="Group">
              <select className={inputClass} value={g} onChange={(e) => setGroupId(e.target.value)}>
                {groups.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-ink-2">
                In reports, money out of it counts as
              </span>
              <Segmented
                label="Counts as"
                value={k}
                onChange={setKind}
                options={[
                  ['spending', 'Spending'],
                  ['saving', 'Saving or investing'],
                ]}
              />
              <span className="text-[12px] leading-snug text-muted">
                {k === 'saving'
                  ? 'Use for money leaving your budget to grow somewhere else, like a brokerage or an IRA. Shown as Invested, not Spent.'
                  : 'Most categories. Sinking funds like Vacation or Car insurance are Spending too: the money is spent when you use it.'}
              </span>
            </div>
            {!isNew && existing && (
              <Link
                to={`/budget/category/${existing.id}/target`}
                search={{ from: 'categories' }}
                data-track="category_edit.target"
                className="flex min-h-14 items-center justify-between rounded-xl border border-line px-3 text-ink no-underline"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-[15px] font-semibold">Target</span>
                  <span className="text-[12px] text-muted">{existing.meta}</span>
                </span>
                <Icon name="chevR" size={18} className="text-faint" />
              </Link>
            )}
          </>
        )}
        {error ? <ErrorNote error={error} /> : null}
        <PrimaryButton
          mutates
          track="category_edit.save"
          disabled={!n.trim() || busy || !canWrite}
          onClick={() => void save()}
        >
          {isNew ? (isGroup ? 'Add group' : 'Add category') : 'Save'}
        </PrimaryButton>
        {editingGroup &&
          (editingGroup.categories.length === 0 ? (
            <Button
              mutates
              track="categories.remove_group"
              onClick={() =>
                void api.removeGroup(editingGroup.id).then(
                  () => {
                    void qc.invalidateQueries({ queryKey: qk.categories });
                    void qc.invalidateQueries({ queryKey: ['budget'] });
                    toast.show({ text: `${editingGroup.name} removed` });
                    close();
                  },
                  (e: unknown) => setError(e),
                )
              }
              className="mt-3 min-h-10 self-start text-[14px] font-bold text-over-fg"
            >
              Remove group {editingGroup.name}
            </Button>
          ) : (
            <span className="text-[12px] leading-snug text-muted">
              To remove this group, move or remove its categories first.
            </span>
          ))}
        {isNew && !isGroup && (
          <SecondaryButton
            mutates
            track="category_edit.save_target"
            disabled={!n.trim() || busy || !canWrite}
            onClick={() => void save(true)}
          >
            Add and set a target
          </SecondaryButton>
        )}
        {!isNew &&
          existing &&
          (asking ? (
            <div
              role="alertdialog"
              aria-label={`Remove ${existing.name}`}
              className="mt-3 flex flex-col gap-2.5 rounded-xl bg-over-bg p-3 text-over-fg"
            >
              <span className="text-[14px] leading-snug">
                Remove {existing.name}?
                {existing.available > 0
                  ? ` Its ${formatCents(existing.available)} goes back to Ready to Assign.`
                  : ''}{' '}
                If it has history it’s archived, so past transactions and reports keep it.
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setAsking(false)}
                  className="h-11 flex-1 rounded-[10px] border border-line-strong bg-surface text-[14px] font-bold text-ink-2"
                >
                  Keep it
                </button>
                <Button
                  mutates
                  track="category_edit.remove.confirm"
                  onClick={() => void remove()}
                  className="h-11 flex-1 rounded-[10px] bg-danger text-[14px] font-bold text-on-danger"
                >
                  Remove
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-track="category_edit.remove"
              onClick={() => setAsking(true)}
              className="mt-3 min-h-10 self-start text-[14px] font-bold text-over-fg"
            >
              Remove {existing.name}…
            </button>
          ))}
      </div>
    </Sheet>
  );
}
