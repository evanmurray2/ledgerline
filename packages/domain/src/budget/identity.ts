// Rule 10, asserted after every recompute (decisions.md D-14):
//
//   Σ cash and card working balances
//     = Σ available in every non-payment category (current month)
//     + Ready to Assign + Waiting to match + unsorted transfer sides (net) + uncategorized amounts (signed)
//     − unbudgeted card debt (0 when every card is fully budgeted; then this is rule 10 word for word)
//     + what already belongs to later months (their assignments, income set aside for them, their activity).
//
// Card payment categories are left out: each mirrors card debt already counted in the card balances (rule 7
// checks them separately).
import { type Cents, cents } from '../money.js';
import type { Month } from '../month.js';
import type { ComputeResult } from './compute.js';
import type { Projection } from './project.js';

export interface IdentityReport {
  ok: boolean;
  left: Cents;
  right: Cents;
  difference: Cents;
  terms: {
    working: Cents;
    categories: Cents;
    rta: Cents;
    waitingToMatch: Cents;
    unsortedNet: Cents;
    uncategorizedNet: Cents;
    unbudgetedCardDebt: Cents;
    laterMonths: Cents;
  };
  /** True when the identity holds with no unbudgeted card debt: rule 10 exactly as written. */
  literal: boolean;
}

export function checkIdentity(p: Projection, r: ComputeResult, currentMonth: Month): IdentityReport {
  let working = 0;
  for (const v of Object.values(p.working)) working += v;
  const cur = r.months.find((m) => m.month === currentMonth);
  let categories = 0;
  if (cur) for (const c of Object.values(cur.categories)) categories += c.available;
  let k = 0;
  for (const v of Object.values(r.unbudgetedCardDebt)) k += v;
  let later = 0;
  for (const m of r.months) {
    if (m.month <= currentMonth) continue;
    for (const c of Object.values(m.categories)) later += c.assigned + c.activity;
    for (const c of Object.values(m.cards)) later += c.assigned;
    later += m.inflows - m.owed;
  }
  const right = categories + r.rta + p.waitingToMatch + p.unsortedNet + p.uncategorizedNet - k + later;
  const difference = working - right;
  return {
    ok: difference === 0,
    left: cents(working),
    right: cents(right),
    difference: cents(difference),
    terms: {
      working: cents(working),
      categories: cents(categories),
      rta: r.rta,
      waitingToMatch: p.waitingToMatch,
      unsortedNet: p.unsortedNet,
      uncategorizedNet: p.uncategorizedNet,
      unbudgetedCardDebt: cents(k),
      laterMonths: cents(later),
    },
    literal: difference === 0 && k === 0,
  };
}

export class IdentityError extends Error {
  constructor(readonly report: IdentityReport) {
    super(`budget identity off by ${report.difference} cents`);
    this.name = 'IdentityError';
  }
}

export function assertIdentity(p: Projection, r: ComputeResult, currentMonth: Month): IdentityReport {
  const rep = checkIdentity(p, r, currentMonth);
  if (!rep.ok) throw new IdentityError(rep);
  return rep;
}
