// Names people type, shared by several contract files. Split from index.ts, which re-exports them.
import { z } from 'zod';

/** Characters that change how text around them reads (bidi overrides and isolates) or don't show (controls). */
export const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/** A payee's name as you type it: trimmed first, so a name of only spaces is empty, and no hidden characters. */
export const payeeName = z
  .string()
  .trim()
  .min(1, 'Enter a payee.')
  .max(120)
  .refine((n) => !HIDDEN_CHARS.test(n), 'Use letters, numbers and punctuation only.');
