// What an edit that depends on a balance needs from the screens (D-45): the amount this device shows, and the change
// number its copy stood at when it worked that out (`through`). The route takes the edit only when nothing changed
// after `through` (apps/worker/src/http/through.ts). Every edit of a locked budget runs on the device (D-102), so
// the device adds these to the edit before the engine runs it:
// - Archiving (or removing) a category sends its available, so the money goes back to Ready to Assign.
// - Close account sends the working balance and a card payment category's available (D-73, D-93).
// Other edits need nothing.

/** The parts of the engine host this needs (host.ts). */
export interface ShownHost {
  request(method: string, path: string): Promise<{ status: number; body: string }>;
  state(): Promise<{ through: number }>;
}

export type Shown =
  { available: number; through: number } | { working: number; available: number; through: number };

const ARCHIVE = /^\/api\/settings\/categories\/([^/]+)\/(archive|remove)$/;
const CLOSE = /^\/api\/accounts\/([^/]+)\/close$/;

/** The fields to add to the edit's body, or null when it needs none. `sync` brings the copy up to date first. */
export async function shownFields(
  host: ShownHost,
  method: string,
  path: string,
  body: unknown,
  sync: () => Promise<void>,
): Promise<Shown | null> {
  if (method !== 'POST') return null;
  const p = path.split('?')[0]!;
  const archive = ARCHIVE.exec(p);
  const close = CLOSE.exec(p);
  // A restore moves no money out, so it needs nothing.
  if (archive?.[2] === 'archive' && !(body as { archived?: boolean } | undefined)?.archived) return null;
  if (!archive && !close) return null;
  // The newest amounts this device can have. With no connection, the copy as it is.
  await sync().catch(() => undefined);
  if (archive) {
    const r = await host.request('GET', `/api/categories/${archive[1]!}/sheet`);
    if (r.status !== 200) return null;
    const { available } = JSON.parse(r.body) as { available: number };
    return { available, through: (await host.state()).through };
  }
  const r = await host.request('GET', `/api/accounts/${close![1]!}/register`);
  if (r.status !== 200) return null;
  const v = JSON.parse(r.body) as { account: { working: number }; cardAvailable: number | null };
  return {
    working: v.account.working,
    available: v.cardAvailable ?? 0,
    through: (await host.state()).through,
  };
}
