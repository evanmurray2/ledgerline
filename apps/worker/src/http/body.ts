// Pieces of the Zod schemas that check request bodies.
import { isBase64 } from '@ledgerline/platform';
import { z } from 'zod';

/**
 * Base64 text of at most `max` characters, as `^[A-Za-z0-9+/]+={0,2}$` says, checked without running that pattern:
 * over a write of 16 entries of 64 KB it cost about 7 ms (packages/platform base64.ts `isBase64`).
 */
export const base64Text = (max: number) => z.string().max(max).refine(isBase64);
