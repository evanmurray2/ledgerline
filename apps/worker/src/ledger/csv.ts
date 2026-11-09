// Reading a CSV file someone imports as history (routes/ops.ts): the shapes banks' exports come in. Commas, semicolons
// or tabs; quoted cells with commas, quotes or line breaks; one signed amount or Debit and Credit columns; US or
// European number styles; and the common date styles. Nothing here decides what a row counts toward.
import { type Cents, type IsoDate, cents, parseCents, parseImportDate } from '@ledgerline/domain';

/** The cells of each record. The delimiter is the one the header line uses most (comma, semicolon or tab). */
export function csvRecords(text: string): { records: string[][]; delimiter: string } {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r|\n|$/));
  const outside = firstLine.replace(/"([^"]|"")*"/g, '');
  const counts = [',', ';', '\t'].map((d) => [d, outside.split(d).length - 1] as const);
  const delimiter = counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) records.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) records.push(row);
  return { records, delimiter };
}

const NAMES = {
  date: [
    'date',
    'transaction date',
    'trans date',
    'trans. date',
    'posted date',
    'posting date',
    'post date',
    'booking date',
  ],
  payee: ['payee', 'description', 'name', 'merchant', 'merchant name', 'details'],
  amount: ['amount', 'transaction amount', 'amount (usd)'],
  debit: ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'withdrawal amount', 'money out'],
  credit: ['credit', 'credits', 'credit amount', 'deposit', 'deposits', 'deposit amount', 'money in'],
  memo: ['memo', 'note', 'notes'],
} as const;

export interface CsvColumns {
  date: number;
  payee: number;
  amount: number;
  debit: number;
  credit: number;
  memo: number;
}

/**
 * The header's columns: a date, a payee and either an amount or Debit and Credit columns. Some banks put a few lines
 * about the account first, so the header is the first of the first 10 records that has them. Null when none has.
 */
export function csvHeader(records: string[][]): { columns: CsvColumns; at: number } | null {
  for (let at = 0; at < Math.min(records.length, 10); at++) {
    const h = records[at]!.map((x) => x.trim().toLowerCase().replace(/\s+/g, ' '));
    const find = (names: readonly string[]) => {
      for (const n of names) {
        const i = h.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const columns: CsvColumns = {
      date: find(NAMES.date),
      payee: find(NAMES.payee),
      amount: find(NAMES.amount),
      debit: find(NAMES.debit),
      credit: find(NAMES.credit),
      memo: find(NAMES.memo),
    };
    if (
      columns.date >= 0 &&
      columns.payee >= 0 &&
      (columns.amount >= 0 || columns.debit >= 0 || columns.credit >= 0)
    )
      return { columns, at };
  }
  return null;
}

/**
 * One amount cell. "1.234,56" and "-12,50" (a comma before the last one or two digits) are European style; in a
 * semicolon file, "1.234" is too. Anything else goes to parseCents ("1,234.56", "$3.07", "(12.00)").
 */
export function csvAmount(input: string, delimiter: string): Cents | null {
  let s = input.trim().replace(/\s/g, '');
  if (!s) return null;
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma > dot && /,\d{1,2}\)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (delimiter === ';' && comma < 0 && /^\D*\d{1,3}(\.\d{3})+\)?$/.test(s)) s = s.replace(/\./g, '');
  try {
    return parseCents(s);
  } catch {
    return null;
  }
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
/** "Nov", "nov." or "November" (at least three letters of the name). */
const monthNo = (name: string) => {
  const n = name.toLowerCase();
  const i = MONTHS.findIndex((m) => n.length >= 3 && m.startsWith(n));
  return i < 0 ? null : String(i + 1);
};
const pad = (n: string) => n.padStart(2, '0');
const year = (y: string) => (y.length === 2 ? `20${y}` : y);

/**
 * One date cell: "2026-11-02" (a time after it is ignored), "2026/11/02", US "11/2/2026", "11-2-2026" and "11/2/26",
 * day-first with dots "2.11.2026", and "Nov 2, 2026", "2 Nov 2026" or "02-Nov-26". Null when it isn't a real calendar
 * date (Feb 30, month 13, or day-first with slashes such as "25/12/2025").
 */
export function csvDate(input: string): IsoDate | null {
  const t = input.trim().replace(/^(\d{4}-\d{2}-\d{2})[T ].*$/, '$1');
  let m: RegExpExecArray | null;
  let iso: string | null = null;
  if ((m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(t))) iso = `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`;
  else if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(t)))
    iso = `${year(m[3]!)}-${pad(m[1]!)}-${pad(m[2]!)}`;
  else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t))) iso = `${m[3]}-${pad(m[2]!)}-${pad(m[1]!)}`;
  else if ((m = /^([a-z]{3,9})\.? (\d{1,2}),? (\d{4})$/i.exec(t))) {
    const mo = monthNo(m[1]!);
    iso = mo ? `${m[3]}-${pad(mo)}-${pad(m[2]!)}` : null;
  } else if ((m = /^(\d{1,2})[ -]([a-z]{3,9})\.?[ -](\d{4}|\d{2})$/i.exec(t))) {
    const mo = monthNo(m[2]!);
    iso = mo ? `${year(m[3]!)}-${pad(mo)}-${pad(m[1]!)}` : null;
  } else iso = t;
  return iso ? parseImportDate(iso) : null;
}

/** A record's amount: the Amount column, else Credit minus Debit (either may be blank, or signed). */
export function recordAmount(cols: string[], c: CsvColumns, delimiter: string): Cents | null {
  if (c.amount >= 0) return csvAmount(cols[c.amount] ?? '', delimiter);
  const cell = (i: number) => (i >= 0 ? (cols[i] ?? '').trim() : '');
  const d = cell(c.debit);
  const cr = cell(c.credit);
  if (!d && !cr) return null;
  const debit = d ? csvAmount(d, delimiter) : 0;
  const credit = cr ? csvAmount(cr, delimiter) : 0;
  if (debit === null || credit === null) return null;
  return cents(Math.abs(credit) - Math.abs(debit));
}
