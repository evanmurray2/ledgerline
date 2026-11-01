// Owed to you: a list, not a category. Close out what's owed (they won't pay / marked by mistake / more time).
import { useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import type { OwedView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useActivity, useMoneyMutation, useOwed, useBudget, useSession } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  BackHeader,
  Card,
  cx,
  ErrorNote,
  Field,
  inputClass,
  Loading,
  OptionCard,
  PrimaryButton,
  SecondaryButton,
  Segmented,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel, monthName } from '../lib/dates';
import { useScreen } from '../lib/common';
import { usage } from '../usage/tracker';

type Item = OwedView['items'][number];

function isOpen(i: Item) {
  return i.status === 'open' || i.status === 'late';
}

export function OwedScreen() {
  useScreen('owed');
  const q = useOwed();
  const navigate = useNavigate();
  const activity = useActivity('attention', '');
  const session = useSession();
  const budget = useBudget(session.data?.budget.currentMonth);
  const v = q.data;
  const waiting = activity.data?.moneyToMatch[0];
  const rta = budget.data?.rta ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BackHeader
        title="Owed to you"
        onBack={() => void navigate({ to: '/budget' })}
        backLabel="Back to budget"
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 pt-3">
        {!v ? (
          q.error ? (
            <ErrorNote error={q.error} />
          ) : (
            <Loading />
          )
        ) : (
          <>
            <section className="flex shrink-0 flex-col gap-1.5 rounded-[14px] border border-line bg-surface p-3">
              <span className="text-[12px] text-muted">Out with others</span>
              <span className="tnum text-[24px] font-bold">{formatCents(v.out)}</span>
              <span className="text-[13px] leading-[1.45] text-ink-2">
                Money you front comes out of Ready to Assign. When it’s paid back, it goes back to Ready to
                Assign. This is a list, not a category, so it holds no money.
              </span>
            </section>
            {waiting && (
              <Link
                to={`/owed/match/${waiting.key}`}
                data-track="owed.waiting.match"
                className="flex min-h-14 shrink-0 items-center gap-2.5 rounded-[14px] border border-success-border bg-success-soft px-3 py-2 text-funded-fg no-underline"
              >
                <span className="flex flex-1 flex-col gap-px">
                  <span className="text-[14px] font-bold">
                    {waiting.payee} {formatCents(waiting.amount, { plus: true })} is waiting to match
                  </span>
                  <span className="text-[12px]">
                    Held outside Ready to Assign. Could pay back what’s listed below.
                  </span>
                </span>
                <span className="text-[14px] font-bold underline">Match</span>
              </Link>
            )}
            {v.projected.map((p) => (
              <p
                key={p.key}
                className="m-0 shrink-0 rounded-xl bg-under-bg px-3 py-2.5 text-[13px] leading-[1.45] text-under-fg"
              >
                {p.label} takes {formatCents(p.owed, { whole: true })} out of Ready to Assign until it’s paid
                back. You have {formatCents(rta)}
                {waiting
                  ? ` now, ${formatCents(rta + waiting.amount)} once the ${waiting.payee.split(' ')[0]} money is matched`
                  : ''}
                {rta + (waiting?.amount ?? 0) >= p.owed
                  ? ', enough to cover it.'
                  : `. Keep ${formatCents(p.owed, { whole: true })} unassigned, or Ready to Assign will go negative on ${dayLabel(p.date)}.`}
              </p>
            ))}
            <h2 className="m-0 mt-1 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">
              Still owed
            </h2>
            <Card>
              {v.items.filter(isOpen).length === 0 && (
                <p className="m-0 px-3 py-3.5 text-[14px] font-semibold text-funded-fg">
                  Nothing is owed to you.
                </p>
              )}
              {v.items.filter(isOpen).map((o) => {
                const late = o.status === 'late';
                return (
                  <div
                    key={o.id}
                    className="flex flex-col gap-2 border-t border-divider p-3 first:border-t-0"
                  >
                    <Link
                      to={`/activity/txn/${o.txnKey}`}
                      className="flex justify-between gap-2.5 text-ink no-underline"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-[15px] font-semibold">{o.label}</span>
                        <span className="text-[12px] text-muted">{o.sub}</span>
                        <span className={cx('text-[12px]', late ? 'text-over-fg' : 'text-muted')}>
                          {late ? 'Late · ' : ''}
                          {o.expectBy
                            ? `${late ? 'expected' : 'Expected'} by ${dayLabel(o.expectBy)}`
                            : 'No date'}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        <span className="tnum text-[15px] font-bold">{formatCents(o.still)}</span>
                        <span className="text-[11px] text-muted">
                          {o.still === o.amount
                            ? 'all of it'
                            : `of ${formatCents(o.amount, { whole: true })} owed`}
                        </span>
                      </span>
                    </Link>
                    <div className="flex gap-2">
                      {waiting ? (
                        <Link
                          to={`/owed/match/${waiting.key}`}
                          data-track="owed.match"
                          aria-label={`Match money back for ${o.label}`}
                          className="hit flex h-9 flex-1 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent no-underline"
                        >
                          Match money back
                        </Link>
                      ) : (
                        <span className="flex h-9 flex-1 items-center justify-center rounded-full bg-sunken text-[13px] font-bold text-muted">
                          Nothing to match yet
                        </span>
                      )}
                      <Link
                        to={`/owed/close/${o.id}`}
                        data-track="owed.close"
                        aria-label={`Close out ${o.label}`}
                        className="hit flex h-9 flex-1 items-center justify-center rounded-full border border-line-strong text-[13px] font-bold text-ink-2 no-underline"
                      >
                        Close out
                      </Link>
                    </div>
                  </div>
                );
              })}
            </Card>
            {v.items.some((o) => o.matched > 0) && (
              <>
                <h2 className="m-0 mt-1 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">
                  Paid back recently
                </h2>
                <Card>
                  {v.items
                    .filter((o) => o.matched > 0)
                    .map((o) => (
                      <Link
                        key={o.id}
                        to={`/activity/txn/${o.txnKey}`}
                        className="flex min-h-14 items-center justify-between border-t border-divider px-3 py-1.5 text-ink no-underline first:border-t-0"
                      >
                        <span className="flex flex-col gap-0.5">
                          <span className="text-[15px] font-semibold">{o.label}</span>
                          <span className="text-[12px] text-muted">
                            {o.status === 'paid_back'
                              ? 'Paid back in full'
                              : `${formatCents(o.still)} still open`}
                          </span>
                        </span>
                        <span className="tnum text-[15px] font-bold text-funded-fg">
                          {formatCents(o.matched, { plus: true })}
                        </span>
                      </Link>
                    ))}
                </Card>
              </>
            )}
          </>
        )}
      </div>
      <Outlet />
    </div>
  );
}

type Pick = 'close' | 'cancel' | 'snooze';

export function CloseSheet() {
  const { itemId } = useParams({ strict: false }) as { itemId: string };
  useScreen('owed.close');
  const q = useOwed();
  const navigate = useNavigate();
  const session = useSession();
  const back = () => void navigate({ to: '/owed' });
  const act = useMoneyMutation((v: { id: string; body: Parameters<typeof api.owedAction>[1] }) =>
    api.owedAction(v.id, v.body),
  );
  const [sel, setSel] = useState(itemId);
  const [pick, setPick] = useState<Pick>('close');
  const [date, setDate] = useState('');
  const [done, setDone] = useState<{ pick: Pick; text: string; prevDate: string | null } | null>(null);
  const items = (q.data?.items ?? []).filter(isOpen);
  const it = q.data?.items.find((x) => x.id === sel);
  const month = monthName(session.data?.budget.currentMonth ?? '2026-11');
  if (!it) {
    return (
      <Sheet label="Close out" track="owed.close" onClose={back} gap="auto">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  }
  const amt = formatCents(it.still, { whole: true });
  const cat = it.categoryName ?? 'The category';
  const opts: { id: Pick; name: string; desc: string; cta: string; result: string }[] = [
    {
      id: 'close',
      name: 'They won’t pay it',
      desc: `It becomes your spending: ${cat} is charged ${amt} in ${month}, and Ready to Assign gets back the ${amt} it fronted. If that overspends ${cat}, Needs attention will offer to cover it.`,
      cta: `Close out ${amt}`,
      result: `Closed. ${cat} was charged ${amt} in ${month} and Ready to Assign got ${amt} back.`,
    },
    {
      id: 'cancel',
      name: 'I marked it by mistake',
      desc: `Remove the mark. ${cat} is charged the full ${formatCents(it.amount + 0, { whole: true })} in the purchase’s month, Ready to Assign gets the fronted amount back${it.matched > 0 ? `, and the ${formatCents(it.matched, { whole: true })} already paid back stays in Ready to Assign as income` : ''}.`,
      cta: 'Remove the mark',
      result: `Mark removed. ${cat} now carries the full amount.`,
    },
    {
      id: 'snooze',
      name: 'Give it more time',
      desc: `Keep it open with a new date${it.expectBy ? ` (now ${dayLabel(it.expectBy)})` : ''}, so it doesn’t show as late.`,
      cta: 'Save new date',
      result: `Still open, now expected by ${date ? dayLabel(date) : 'the new date'}.`,
    },
  ];
  const cur = opts.find((o) => o.id === pick)!;
  const confirm = async () => {
    await act.mutateAsync({
      id: it.id,
      body: pick === 'snooze' ? { action: 'snooze', expectBy: date || undefined } : { action: pick },
    });
    setDone({ pick, text: cur.result, prevDate: it.expectBy });
  };
  const label = it.still > 0 ? `${it.label.split(' · ')[0]} · ${amt} still owed` : it.label;
  return (
    <Sheet
      label={label}
      track="owed.close"
      onClose={back}
      gap="auto"
      header={<SheetTitle title={label} sub={it.sub} />}
    >
      {done ? (
        <div className="flex flex-col gap-3 pb-4">
          <p
            role="status"
            className="m-0 rounded-xl bg-success-soft p-3 text-[14px] leading-[1.45] text-funded-fg"
          >
            {done.text}
          </p>
          <div className="flex gap-2">
            {done.pick === 'snooze' && done.prevDate && (
              <SecondaryButton
                mutates
                track="owed.close.undo"
                className="flex-1"
                onClick={async () => {
                  await act.mutateAsync({ id: it.id, body: { action: 'snooze', expectBy: done.prevDate! } });
                  usage.undo('snooze');
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
          {items.length > 1 && (
            <Segmented
              label="Which item"
              value={sel}
              onChange={setSel}
              options={items.map((x) => [x.id, x.label.split(' · ')[0] ?? x.label] as const)}
            />
          )}
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
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          )}
          {act.error && <ErrorNote error={act.error} />}
          <PrimaryButton
            mutates
            track="owed.close.confirm"
            className="mt-2"
            disabled={pick === 'snooze' && !date}
            onClick={() => void confirm()}
          >
            {cur.cta}
          </PrimaryButton>
        </div>
      )}
    </Sheet>
  );
}
