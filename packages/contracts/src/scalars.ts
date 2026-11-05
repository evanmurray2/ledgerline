// The scalar schemas every contract file shares: money in integer cents, months 'YYYY-MM', dates 'YYYY-MM-DD', ids.
// Not part of the package's exports (index.ts doesn't re-export them).
import { z } from 'zod';

export const cents = z.number().int();
export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const id = z.string().min(1).max(80);
