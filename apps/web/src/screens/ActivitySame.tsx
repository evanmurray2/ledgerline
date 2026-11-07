// Activity's "Same purchase?" cards (docs/payee-names.md 9.1): one card per bank row that could be the same purchase
// as your entry (or as another bank row), with Yes and No for each candidate. Until you answer, both rows count.
import type { ActivityView, TxnListRow } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { useMoneyMutation } from '../api/hooks';
import { toast } from '../components/Toast';
import { SectionTitle, SoftButton } from '../components/ui';
import { formatCents } from '../lib/money';
import { TxnRow } from './ActivityRows';

type Card = ActivityView['samePurchase'][number];

const named = (r: TxnListRow) => `${r.payee} ${formatCents(Math.abs(r.amount))}`;

export function SamePurchase({ cards }: { cards: Card[] }) {
  const answer = useMoneyMutation(api.samePurchase);
  const say = async (card: Card, c: TxnListRow, yes: boolean) => {
    try {
      await answer.mutateAsync({ id: card.id, answer: yes ? 'yes' : 'no', key: c.key });
      toast.show({ text: yes ? 'Paired as one purchase' : 'Kept as two purchases' });
    } catch (e) {
      toast.show({ text: e instanceof ApiError ? errorMessage(e) : 'Couldn’t save that. Try again.' });
    }
  };
  return (
    <>
      {cards.map((card) => (
        <section key={card.id} className="flex shrink-0 flex-col gap-1.5" data-testid="same-purchase">
          <SectionTitle note="both count until you answer">Same purchase?</SectionTitle>
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <TxnRow r={card.row} base="/activity" />
            {card.candidates.map((c) => (
              <TxnRow
                key={c.key}
                r={c}
                base="/activity"
                action={
                  <span className="flex shrink-0 gap-1.5">
                    <SoftButton
                      mutates
                      tone="filled"
                      track="activity.same_purchase.yes"
                      aria-label={`Yes, ${named(c)} and ${named(card.row)} are the same purchase`}
                      disabled={answer.isPending}
                      onClick={() => void say(card, c, true)}
                    >
                      Yes
                    </SoftButton>
                    <SoftButton
                      mutates
                      tone="outline"
                      track="activity.same_purchase.no"
                      aria-label={`No, ${named(c)} and ${named(card.row)} are not the same purchase`}
                      disabled={answer.isPending}
                      onClick={() => void say(card, c, false)}
                    >
                      No
                    </SoftButton>
                  </span>
                }
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
