// Synthetic budget for the Phase 1 budget-edit measurement: 36 months of history, 60 categories (58 spending or
// saving + 2 card payment categories), about 150 budget lines per month across 4 cash and 2 card accounts.
// Deterministic (seeded), so runs are comparable.

export interface SeedRows {
  categories: { id: string; kind: 'spending' | 'saving' | 'cc_payment'; card_account_id: string | null }[];
  assignments: { category_id: string; month: string; amount: number }[];
  lines: [
    string,
    string,
    string,
    string,
    number,
    string,
    string,
    number,
    string | null,
    number,
    string | null,
  ][];
  startMonth: string;
  months: string[];
}

export function seedBudget(nMonths = 36, nCats = 60, linesPerMonth = 150, startMonth = '2023-12'): SeedRows {
  let s = 42;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
  const months: string[] = [];
  let y = Number(startMonth.slice(0, 4));
  let m = Number(startMonth.slice(5, 7));
  for (let i = 0; i < nMonths; i++) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  const cards = ['card1', 'card2'];
  const cash = ['chk', 'sav1', 'sav2', 'sav3'];
  const spend = Array.from({ length: nCats - cards.length }, (_, i) => `cat${String(i).padStart(2, '0')}`);
  const categories: SeedRows['categories'] = [
    ...spend.map((id, i) => ({
      id,
      kind: (i % 10 === 9 ? 'saving' : 'spending') as 'spending' | 'saving',
      card_account_id: null,
    })),
    ...cards.map((c) => ({ id: `pay_${c}`, kind: 'cc_payment' as const, card_account_id: c })),
  ];
  const assignments: SeedRows['assignments'] = [];
  const lines: SeedRows['lines'] = [];
  let k = 0;
  lines.push([
    'start:chk',
    'start',
    months[0]!,
    `${months[0]}-01`,
    -1,
    'rta',
    'chk',
    0,
    null,
    2_000_000,
    null,
  ]);
  lines.push([
    'start:card1',
    'start',
    months[0]!,
    `${months[0]}-01`,
    -1,
    'debt',
    'card1',
    1,
    null,
    150_000,
    null,
  ]);
  for (const mo of months) {
    for (const c of spend)
      assignments.push({ category_id: c, month: mo, amount: Math.round(rnd() * 40_000) + 5_000 });
    assignments.push({ category_id: 'pay_card1', month: mo, amount: 10_000 });
    lines.push([`pay${k++}`, '0', mo, `${mo}-01`, k, 'rta', 'chk', 0, null, 900_000, null]);
    lines.push([`pay${k++}`, '0', mo, `${mo}-15`, k, 'rta', 'chk', 0, null, 900_000, null]);
    for (let i = 0; i < linesPerMonth - 6; i++) {
      const onCard = rnd() < 0.6;
      const day = String(1 + Math.floor(rnd() * 28)).padStart(2, '0');
      const cat = spend[Math.floor(rnd() * spend.length)]!;
      const acct = onCard ? cards[Math.floor(rnd() * 2)]! : cash[Math.floor(rnd() * cash.length)]!;
      lines.push([
        `t${k++}`,
        '0',
        mo,
        `${mo}-${day}`,
        k,
        'cat',
        acct,
        onCard ? 1 : 0,
        cat,
        -Math.round(rnd() * 15_000) - 100,
        null,
      ]);
    }
    for (const c of cards)
      lines.push([`p${k++}`, '0', mo, `${mo}-20`, k, 'payment', c, 1, null, 300_000, null]);
    lines.push([`o${k++}`, 'owed:x', mo, `${mo}-10`, k, 'owed', 'chk', 0, null, 5_000, `item${k}`]);
    lines.push([`r${k++}`, '0', mo, `${mo}-12`, k, 'rta', 'card2', 1, null, 2_000, null]);
  }
  return { categories, assignments, lines, startMonth, months };
}
