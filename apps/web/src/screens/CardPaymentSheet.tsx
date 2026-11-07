// A card's payment category, opened from its account page: what it holds, what the card owes, and the Fund fix.
import { useNavigate, useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useBudget, useMoneyMutation } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import { cx, ErrorNote, Loading, PrimaryButton, StatusWord, TONE } from '../components/ui';
import { formatCents } from '../lib/money';
import { useScreen } from '../lib/common';
import { useBudgetMonth } from './Budget';

export function CardPaymentSheetScreen() {
  const { accountId, categoryId } = useParams({ strict: false }) as { accountId: string; categoryId: string };
  const { month } = useBudgetMonth();
  useScreen('card.payment');
  const navigate = useNavigate();
  const q = useBudget(month);
  const assign = useMoneyMutation(api.assign);
  const close = () => void navigate({ to: `/accounts/${accountId}`, search: true });
  const b = q.data;
  const card = b?.cards.find((c) => c.categoryId === categoryId);

  if (!b || !card || !month) {
    return (
      <Sheet label="Payment category" track="card.payment" onClose={close}>
        {q.error ? <ErrorNote error={q.error} /> : b ? <ErrorNote error={new Error(GONE)} /> : <Loading />}
      </Sheet>
    );
  }
  // The same fix as the card's row in Needs attention: none when covering an overspent category covers the card.
  const fix = b.attention.find((a) => a.key === `card:${card.accountId}`)?.fix ?? null;
  const short = card.status === 'short';
  const tone = short ? 'over' : 'funded';
  const fund = async () => {
    if (!fix) return;
    await assign.mutateAsync({ month, items: [{ categoryId: card.categoryId, amount: fix.amount }] });
    close();
  };
  return (
    <Sheet
      label={card.name}
      track="card.payment"
      onClose={close}
      header={
        <SheetTitle
          title={card.name}
          sub={<StatusWord word={short ? 'Short' : 'Covered'} tone={tone} icon={short ? 'alert' : 'check'} />}
        />
      }
      footer={
        fix ? (
          <PrimaryButton mutates track="card.payment.fund" onClick={fund}>
            Fund {formatCents(fix.amount)}
          </PrimaryButton>
        ) : undefined
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <div className={cx('flex flex-col gap-0.5 rounded-lg p-2.5', TONE[tone].bg)}>
          <span className={cx('text-xs', TONE[tone].fg)}>Available</span>
          <span className={cx('tnum text-lg font-bold', TONE[tone].fg)} data-testid="card-payment-available">
            {formatCents(card.available)}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg bg-page p-2.5">
          <span className="text-xs text-muted">You owe the bank</span>
          <span className="tnum text-lg font-bold">{formatCents(card.owed)}</span>
        </div>
      </div>
      {/* The detail is a Budget row's second line ("statement $611.40 due …"); here it starts a sentence. */}
      <p className="m-0 text-md text-ink">{card.detail.charAt(0).toUpperCase() + card.detail.slice(1)}</p>
      {assign.error && <ErrorNote error={assign.error} />}
    </Sheet>
  );
}

const GONE = 'This was changed or removed. Pull down to refresh.';
