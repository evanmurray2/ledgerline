// Checking request bodies with Zod: the schemas' shared pieces, and reading a body against one.
import { isBase64 } from '@ledgerline/platform';
import { z } from 'zod';

/**
 * Base64 text of at most `max` characters, as `^[A-Za-z0-9+/]+={0,2}$` says, checked without running that pattern:
 * over a write of 16 entries of 64 KB it cost about 16 ms (packages/platform base64.ts `isBase64`).
 */
export const base64Text = (max: number) => z.string().max(max).refine(isBase64);

/** A request's JSON body as `schema` reads it; null when it is missing, broken or doesn't fit. */
export async function parseBody<S extends z.ZodType>(
  req: { json(): Promise<unknown> },
  schema: S,
): Promise<z.infer<S> | null> {
  const r = schema.safeParse(await req.json().catch(() => null));
  return r.success ? r.data : null;
}
