// The requests a locked budget signs with the budget's key (docs/privacy-keys.md 11), the same list as the
// Worker's http/signed-request.ts `signedActionOf`. The Worker decides by the path alone, and refuses a sealed
// budget's request that comes unsigned. A link's finish is signed only for a new bank, as the Worker asks then
// (a repair keeps its link); its link token, to add or to repair, always.
import { ACTION, type Action } from '@ledgerline/seal';

export function signedActionFor(method: string, path: string, body: unknown): Action | null {
  if (method !== 'POST') return null;
  const p = path.split('?')[0]!;
  const mode = (body as { mode?: unknown } | null | undefined)?.mode;
  if (p === '/api/settings/connections/link-token') return ACTION.linkToken;
  if (p === '/api/settings/connections/link-finish') return mode === 'new' ? ACTION.linkFinish : null;
  if (/^\/api\/settings\/connections\/[^/]+\/remove$/.test(p)) return ACTION.removeBank;
  if (p === '/api/cutover/purge') return ACTION.purgeOldCopy;
  if (p === '/api/settings/security/delete-account') return ACTION.deleteAccount;
  if (p === '/api/settings/security/recovery-key') return ACTION.setRecoverySignIn;
  return null;
}
