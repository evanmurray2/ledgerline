// Owed to you: a list, not a category. Close out what's owed (they won't pay / marked by mistake / more time).
import { useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import type { OwedView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useActivity, useMoneyMutation, useOwed, useBudget, useSession } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
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
  SectionTitle,
  Segmented,
  SoftButton,
  softButtonClass,
  useIsDesktop,
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
  const desktop = useIsDesktop();
  // The row's two pills: side by side, half each, on the phone.
  const pill = desktop ? 'px-4' : 'flex-1';

  return (
    <PageFrame>
      <BackHeader
        title="Owed to you"
        onBack={() => void navigate({ to: '/budget' })}
        backLabel="Back to budget"
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
                Money you front leaves Ready to Assign and comes back when you’re paid.
              </span>
            </Card>
            {waiting && (
              <Link
                to={`/owed/match/${waiting.key}`}
                data-track="owed.waiting.match"
                className="flex min-h-14 shrink-0 items-center gap-2.5 rounded-lg bg-owed-bg px-3 py-2 text-owed-fg no-underline"
              >
                <span className="flex flex-1 flex-col gap-px">
                  <span className="text-md font-bold">
                    {waiting.payee} {formatCents(waiting.amount, { plus: true })} is waiting to match
                  </span>
                  <span className="text-xs">Held outside Ready to Assign until you match it.</span>
                </span>
                <span className="text-md font-bold underline">Match</span>
              </Link>
            )}
            {v.projected.map((p) => {
              const covered = rta + (waiting?.amount ?? 0) >= p.owed;
              return (
                <Banner
                  key={p.key}
                  tone={covered ? 'info' : 'warn'}
                  title={
                    covered
                      ? `${p.label} is covered`
                      : `Keep ${formatCents(p.owed, { whole: true })} unassigned for ${p.label}`
                  }
                >
                  It takes {formatCents(p.owed, { whole: true })} from Ready to Assign until it’s paid back.
                  {!covered && (
                    <>
                      {' '}
                      You have {formatCents(rta)} now
                      {waiting
                        ? `, or ${formatCents(rta + waiting.amount)} after you match ${waiting.payee.split(' ')[0]}`
                        : ''}
                      .
                    </>
                  )}
                </Banner>
              );
            })}
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
                      className="flex min-w-0 flex-1 justify-between gap-2.5 text-ink no-underline"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-base font-semibold">{o.label}</span>
                        <span className="text-xs text-muted">{o.sub}</span>
                        <span className={cx('text-xs', late ? 'text-under-fg' : 'text-muted')}>
                          {late ? 'Late · ' : ''}
                          {o.expectBy
                            ? `${late ? 'expected' : 'Expected'} by ${dayLabel(o.expectBy)}`
                            : 'No date'}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        <span className="tnum text-base font-bold">{formatCents(o.still)}</span>
                        <span className="text-xs text-muted">
                          {o.still === o.amount
                            ? 'all of it'
                            : `of ${formatCents(o.amount, { whole: true })} owed`}
                        </span>
                      </span>
                    </Link>
                    <div className={cx('flex gap-2', desktop && 'shrink-0')}>
                      {waiting ? (
                        <Link
                          to={`/owed/match/${waiting.key}`}
                          data-track="owed.match"
                          aria-label={`Match money back for ${o.label}`}
                          className={cx(softButtonClass(), pill)}
                        >
                          Match money back
                        </Link>
                      ) : (
                        <SoftButton disabled className={pill}>
                          Nothing to match yet
                        </SoftButton>
                      )}
                      <Link
                        to={`/owed/close/${o.id}`}
                        data-track="owed.close"
                        aria-label={`Close out ${o.label}`}
                        className={cx(softButtonClass('outline'), pill)}
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
                <SectionTitle>Paid back recently</SectionTitle>
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
      desc: `${cat} is charged ${amt} in ${month}; Ready to Assign gets its ${amt} back.`,
      cta: `Close out ${amt}`,
      result: `Closed. ${cat} was charged ${amt} in ${month} and Ready to Assign got ${amt} back.`,
    },
    {
      id: 'cancel',
      name: 'I marked it by mistake',
      desc: `${cat} carries the full ${formatCents(it.amount + 0, { whole: true })} in the purchase’s month; Ready to Assign gets the fronted amount back${it.matched > 0 ? ` and keeps the ${formatCents(it.matched, { whole: true })} already paid back` : ''}.`,
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
      footer={
        done ? undefined : (
          <PrimaryButton
            mutates
            track="owed.close.confirm"
            disabled={pick === 'snooze' && !date}
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
        </div>
      )}
    </Sheet>
  );
}
