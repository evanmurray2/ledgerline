// Owed to you: a list of what others owe you. Close out what's owed (they won't pay / marked by mistake / more time).
import { useState } from 'react';
import { Link, Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useBack, useHere } from '../lib/back';
import type { OwedView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useMoneyMutation, useOwed, useBudget, useSession } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import { OneBanner, Why } from '../components/Why';
import {
  BackHeader,
  PageFrame,
  Banner,
  Card,
  cx,
  ErrorNote,
  Field,
  inputClass,
  Loading,
  OptionCard,
  PrimaryButton,
  SecondaryButton,
  ScreenBody,
  SoftButton,
  SectionTitle,
  Icon,
  softButtonClass,
  textLinkClass,
  useIsDesktop,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { addMonths, dayLabel, monthName } from '../lib/dates';
import { toast } from '../components/Toast';
import { useScreen } from '../lib/common';
import { usage } from '../usage/tracker';
import { errorMessage } from '../api/client';

type Item = OwedView['items'][number];

function isOpen(i: Item) {
  return i.status === 'open' || i.status === 'late';
}

export function OwedScreen() {
  useScreen('owed');
  const q = useOwed();
  const navigate = useNavigate();
  const { from } = useSearch({ from: '/owed' });
  // Opened from a sheet or another screen (lib/back.ts): Back returns there.
  const back = useBack();
  const here = useHere();
  const session = useSession();
  const budget = useBudget(session.data?.budget.currentMonth);
  const v = q.data;
  // Money in from a person that pays back nothing yet: offered, never held (D-98).
  const payback = v?.payback ?? null;
  const rta = budget.data?.rta ?? 0;
  const desktop = useIsDesktop();
  // Match is the row's main action (a pill); Close out is a quiet text link next to it.
  const pill = desktop ? 'px-4' : '';

  return (
    <PageFrame>
      <BackHeader
        title="Owed to you"
        onBack={back ? back.go : () => void navigate({ to: from === 'accounts' ? '/accounts' : '/budget' })}
        backLabel={back ? back.label : from === 'accounts' ? 'Back to accounts' : 'Back to budget'}
      />
      <ScreenBody>
        {!v ? (
          q.error ? (
            <ErrorNote error={q.error} />
          ) : (
            <Loading />
          )
        ) : (
          <>
            <Card className="flex flex-col gap-1.5 p-3">
              <span className="text-xs text-muted">Out with others</span>
              <span className="tnum text-4xl font-bold">{formatCents(v.out)}</span>
              <span className="text-sm leading-normal text-ink-2">
                Money paid back counts in Ready to Assign as soon as it comes in.
              </span>
            </Card>
            {/* One banner at a time: a shortfall first, then money that may be a payback, then what's covered. */}
            <OneBanner
              items={[
                ...v.projected
                  .filter((p) => rta < p.owed)
                  .map((p) => (
                    <Banner
                      key={p.key}
                      tone="warn"
                      title={`Leave ${formatCents(p.owed)} in Ready to Assign for ${p.label}`}
                    >
                      <Why track="owed.projected.why">
                        This payment takes {formatCents(p.owed)} from Ready to Assign until you’re paid back.
                        Ready to Assign has {formatCents(rta)} now.
                      </Why>
                    </Banner>
                  )),
                payback && (
                  <Link
                    key="payback"
                    to={`/owed/match/${payback.key}`}
                    search
                    data-track="owed.payback.match"
                    className="flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg bg-owed-bg px-3 py-2 text-owed-fg no-underline"
                  >
                    <span className="flex-1 text-md font-bold">
                      {payback.payee} {formatCents(payback.amount, { plus: true })} came in. Is it money back?
                    </span>
                    <span className="text-md font-bold underline">Match</span>
                  </Link>
                ),
                ...v.projected
                  .filter((p) => rta >= p.owed)
                  .map((p) => <Banner key={p.key} tone="info" title={`${p.label} is covered`} />),
              ]}
            />
            <SectionTitle>Still owed</SectionTitle>
            <Card>
              {v.items.filter(isOpen).length === 0 && (
                <p className="m-0 px-3 py-3.5 text-md font-semibold text-funded-fg">
                  Nothing is owed to you.
                </p>
              )}
              {v.items.filter(isOpen).map((o) => {
                const late = o.status === 'late';
                return (
                  <div
                    key={o.id}
                    // Desktop: the buttons sit to the right of the amount instead of on a line of their own.
                    className={cx(
                      'flex gap-2 border-t border-divider p-3 first:border-t-0',
                      desktop ? 'items-center gap-4' : 'flex-col',
                    )}
                  >
                    <Link
                      to={`/activity/txn/${o.txnKey}`}
                      search={{ close: here }}
                      className="flex min-w-0 flex-1 justify-between gap-2.5 text-ink no-underline"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-base font-semibold">{o.label}</span>
                        <span className="text-xs text-muted">{o.sub}</span>
                        <span className={cx('text-xs', late ? 'text-under-fg' : 'text-muted')}>
                          {o.expectBy
                            ? `${late ? 'Late · expected' : 'Expected'} by ${dayLabel(o.expectBy)}`
                            : late
                              ? 'Late'
                              : 'No date'}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        <span className="tnum text-base font-bold">{formatCents(o.still)}</span>
                        {o.still !== o.amount && (
                          <span className="text-xs text-muted">of {formatCents(o.amount)} owed</span>
                        )}
                      </span>
                    </Link>
                    <div className={cx('flex items-center gap-4', desktop && 'shrink-0')}>
                      {payback && (
                        <Link
                          to={`/owed/match/${payback.key}`}
                          search
                          data-track="owed.match"
                          aria-label={`Match money back for ${o.label}`}
                          className={cx(softButtonClass(), pill)}
                        >
                          Match money back
                        </Link>
                      )}
                      <Link
                        to={`/owed/close/${o.id}`}
                        search
                        data-track="owed.close"
                        aria-label={`Close out ${o.label}`}
                        className={cx(textLinkClass, 'self-center px-1')}
                      >
                        Close out
                      </Link>
                    </div>
                  </div>
                );
              })}
            </Card>
            <ClosedOut items={v.items} current={session.data?.budget.currentMonth ?? null} />
            {v.items.some((o) => o.matched > 0) && (
              <>
                <SectionTitle>Paid back recently</SectionTitle>
                <Card>
                  {v.items
                    .filter((o) => o.matched > 0)
                    .map((o) => (
                      <Link
                        key={o.id}
                        to={`/activity/txn/${o.txnKey}`}
                        search={{ close: here }}
                        className="flex min-h-14 items-center justify-between border-t border-divider px-3 py-1.5 text-ink no-underline first:border-t-0"
                      >
                        <span className="flex flex-col gap-0.5">
                          <span className="text-base font-semibold">{o.label}</span>
                          <span className="text-xs text-muted">
                            {o.status === 'paid_back'
                              ? 'Paid back in full'
                              : `${formatCents(o.still)} still open`}
                          </span>
                        </span>
                        <span className="tnum text-base font-bold text-funded-fg">
                          {formatCents(o.matched, { plus: true })}
                        </span>
                      </Link>
                    ))}
                </Card>
              </>
            )}
          </>
        )}
      </ScreenBody>
      <Outlet />
    </PageFrame>
  );
}

type Pick = 'close' | 'cancel' | 'snooze';

export function CloseSheet() {
  const { itemId } = useParams({ strict: false }) as { itemId: string };
  useScreen('owed.close');
  const q = useOwed();
  const navigate = useNavigate();
  const session = useSession();
  const back = () => void navigate({ to: '/owed', search: true });
  const act = useMoneyMutation((v: { id: string; body: Parameters<typeof api.owedAction>[1] }) =>
    api.owedAction(v.id, v.body),
  );
  const [sel, setSel] = useState(itemId);
  const [pick, setPick] = useState<Pick>('close');
  const [date, setDate] = useState('');
  const [done, setDone] = useState<{
    pick: Pick;
    text: string;
    prevDate: string | null;
    item: OwedView['items'][number];
  } | null>(null);
  const items = (q.data?.items ?? []).filter(isOpen);
  // After Remove the mark the list no longer has the item, so the done step keeps the one it acted on.
  const it = q.data?.items.find((x) => x.id === sel) ?? (done?.item.id === sel ? done.item : undefined);
  const month = monthName(session.data?.budget.currentMonth ?? '2026-11');
  const today = session.data?.budget.today ?? '';
  if (!it || (!done && !isOpen(it))) {
    // An item that isn't on the list (a link to one removed, or a wrong id), or one with nothing left to close: say
    // so, with nothing to act on. The server refuses those actions too.
    const gone = !!q.data && !it;
    const note = !it
      ? 'This item isn’t on your Owed to you list any more.'
      : it.status === 'paid_back'
        ? `${it.label.split(' · ')[0]} is paid back in full. There’s nothing to close out.`
        : it.status === 'closed'
          ? `${it.label.split(' · ')[0]} is already closed out. Reopen it on Owed to you to change it.`
          : `${it.label.split(' · ')[0]} isn’t marked as owed any more.`;
    return (
      <Sheet
        label="Close out"
        track="owed.close"
        onClose={back}
        gap="auto"
        footer={
          gone || it ? (
            <PrimaryButton track="owed.close.done" onClick={back}>
              Done
            </PrimaryButton>
          ) : undefined
        }
      >
        {gone || it ? (
          <Banner tone="info">{note}</Banner>
        ) : q.error ? (
          <ErrorNote error={q.error} />
        ) : (
          <Loading />
        )}
      </Sheet>
    );
  }
  const amt = formatCents(it.still);
  const full = formatCents(it.amount);
  const cat = it.categoryName ?? 'Its category';
  const opts: { id: Pick; name: string; desc: string; cta: string; result: string }[] = [
    {
      id: 'close',
      name: 'They won’t pay it',
      desc: `${cat} is charged ${amt} in ${month}, and Ready to Assign gets ${amt} back. If ${cat} hasn’t got the money, it’s overspent.`,
      cta: `Close out ${amt}`,
      result: `Closed. ${cat} was charged ${amt} in ${month}.`,
    },
    {
      id: 'cancel',
      name: 'I marked it by mistake',
      // Rule 11: the owed part comes back to Ready to Assign and the category is charged it in the purchase's month.
      // In a past month the category often hasn't got it: that overspending comes out of Ready to Assign again at the
      // month's end (rule 6), so Ready to Assign may not move at all.
      desc: `${cat} is charged the ${full} too, in the purchase’s month, instead of Ready to Assign. Any overspending that makes comes out of Ready to Assign at the end of that month.${it.matched > 0 ? ` The ${formatCents(it.matched)} paid back stays in Ready to Assign.` : ''}`,
      cta: 'Remove the mark',
      result: `Removed. ${cat} is charged the ${full} too.`,
    },
    {
      id: 'snooze',
      name: 'Give it more time',
      desc: 'Set a new date, so it isn’t late.',
      cta: 'Save new date',
      result: `Now expected by ${date ? dayLabel(date) : 'the new date'}.`,
    },
  ];
  const cur = opts.find((o) => o.id === pick)!;
  // A date that has gone by would leave it late at once.
  const pastDate = pick === 'snooze' && !!date && !!today && date < today;
  // A refusal shows under the choices (act.error); nothing is left uncaught.
  const confirm = async () => {
    try {
      await act.mutateAsync({
        id: it.id,
        body: pick === 'snooze' ? { action: 'snooze', expectBy: date || undefined } : { action: pick },
      });
    } catch {
      return;
    }
    setDone({ pick, text: cur.result, prevDate: it.expectBy, item: it });
  };
  const label = it.still > 0 ? `${it.label.split(' · ')[0]} · ${amt} still owed` : it.label;
  return (
    <Sheet
      label={label}
      track="owed.close"
      onClose={back}
      gap="auto"
      header={<SheetTitle title={label} sub={it.sub} />}
      footer={
        done ? undefined : (
          <PrimaryButton
            mutates="offline"
            track="owed.close.confirm"
            disabled={(pick === 'snooze' && !date) || pastDate}
            why={
              pick === 'snooze' && !date
                ? 'Choose a new date'
                : pastDate
                  ? 'Choose today or a later date'
                  : ''
            }
            onClick={() => void confirm()}
          >
            {cur.cta}
          </PrimaryButton>
        )
      }
    >
      {done ? (
        <div className="flex flex-col gap-3 pb-4">
          <Banner tone="success" icon="check">
            {done.text}
          </Banner>
          <div className="flex gap-2">
            {(done.pick !== 'snooze' || done.prevDate) && (
              <SecondaryButton
                mutates="offline"
                track="owed.close.undo"
                className="flex-1"
                onClick={async () => {
                  // Close out and Remove the mark are undone by reopening the item (D-80): in the same month, as
                  // if neither happened.
                  try {
                    await act.mutateAsync({
                      id: it.id,
                      body:
                        done.pick === 'snooze'
                          ? { action: 'snooze', expectBy: done.prevDate! }
                          : { action: 'reopen' },
                    });
                  } catch (e) {
                    toast.show({ text: errorMessage(e) });
                    return;
                  }
                  usage.undo(done.pick);
                  setDone(null);
                }}
              >
                Undo
              </SecondaryButton>
            )}
            <PrimaryButton className="flex-[2]" onClick={back}>
              Done
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 pb-4">
          {items.length > 1 && <ItemStepper items={items} sel={sel} onChange={setSel} />}
          {opts.map((o) => (
            <OptionCard
              key={o.id}
              selected={pick === o.id}
              onClick={() => setPick(o.id)}
              title={o.name}
              desc={o.desc}
              track={`owed.close.${o.id}`}
            />
          ))}
          {pick === 'snooze' && (
            <Field label="New expected-by date">
              <input
                type="date"
                className={inputClass}
                min={today || undefined}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          )}
          {act.error && <ErrorNote error={act.error} />}
        </div>
      )}
    </Sheet>
  );
}

/**
 * ‹ Rent · 1 of 3 › : steps through the open items. Tabs here would read as a choice of mode, as they do
 * elsewhere in the app; arrows say "the next one".
 */
function ItemStepper({
  items,
  sel,
  onChange,
}: {
  items: { id: string; label: string }[];
  sel: string;
  onChange: (id: string) => void;
}) {
  const i = Math.max(
    0,
    items.findIndex((x) => x.id === sel),
  );
  const name = (n: number) => items[n]!.label.split(' · ')[0] ?? items[n]!.label;
  const arrow = (to: number, dir: 'chevL' | 'chevR', what: string) => (
    <button
      type="button"
      data-track="owed.close.step"
      aria-label={to >= 0 && to < items.length ? `${what}: ${name(to)}` : what}
      disabled={to < 0 || to >= items.length}
      onClick={() => onChange(items[to]!.id)}
      className="hit flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-sunken disabled:text-disabled"
    >
      <Icon name={dir} size={20} stroke={2.5} />
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Which item"
      className="flex items-center justify-between rounded-lg bg-page px-1 py-1"
    >
      {arrow(i - 1, 'chevL', 'Previous')}
      <span className="flex min-w-0 flex-col items-center" aria-live="polite">
        <span className="truncate text-base font-bold">{name(i)}</span>
        <span className="text-xs text-muted">
          {i + 1} of {items.length}
        </span>
      </span>
      {arrow(i + 1, 'chevR', 'Next')}
    </div>
  );
}

/**
 * Items closed out in the last three months, with Reopen (D-80). One closed this month reopens as if it was never
 * closed; one closed earlier leaves that month as it was, and the category gets the amount back this month.
 */
function ClosedOut({ items, current }: { items: Item[]; current: string | null }) {
  const act = useMoneyMutation((id: string) => api.owedAction(id, { action: 'reopen' }));
  if (!current) return null;
  const since = addMonths(current, -2);
  const closed = items.filter((o) => o.status === 'closed' && o.closedMonth && o.closedMonth >= since);
  if (!closed.length) return null;
  return (
    <>
      <SectionTitle>Closed out</SectionTitle>
      <Card>
        {closed.map((o) => {
          const amt = formatCents(o.closedAmount ?? 0);
          const cat = o.categoryName ?? 'Its category';
          return (
            <div
              key={o.id}
              className="flex min-h-14 items-center justify-between gap-3 border-t border-divider px-3 py-1.5 first:border-t-0"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-base font-semibold">{o.label}</span>
                <span className="text-xs text-muted">
                  {amt} closed out in {monthName(o.closedMonth!)}
                </span>
              </span>
              <SoftButton
                mutates="offline"
                track="owed.reopen"
                aria-label={`Reopen ${o.label}`}
                disabled={act.isPending}
                onClick={async () => {
                  try {
                    await act.mutateAsync(o.id);
                  } catch (e) {
                    toast.show({ text: errorMessage(e) });
                    return;
                  }
                  usage.undo('close');
                  toast.show({
                    text:
                      o.closedMonth === current
                        ? `Reopened. ${cat} isn’t charged the ${amt}.`
                        : `Reopened. ${cat} gets ${amt} back in ${monthName(current)}.`,
                  });
                }}
              >
                Reopen
              </SoftButton>
            </div>
          );
        })}
      </Card>
    </>
  );
}
