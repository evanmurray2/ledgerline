// Types for the Plaid-shaped mock data generator (data.mjs), used by tests and the measurement harnesses.
export const ACCOUNTS: Array<{
  account_id: string;
  name: string;
  type: string;
  subtype: string;
  mask: string;
  bal: number;
}>;
export function txn(i: number, total: number): Record<string, unknown>;
export function generate(total: number, seed?: number): Array<Record<string, unknown>>;
export function syncBody(data: unknown[], start: number, count: number): string;
