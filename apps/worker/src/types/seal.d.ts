// The part of @ledgerline/seal the Worker uses, as types only. The package's sources are written against the
// browser's WebCrypto types and don't type-check under Cloudflare's (the two disagree on a few algorithm shapes),
// and packages/seal is an owner path, so the Worker's type check reads this instead (tsconfig `paths`). The
// bundler and the tests load the real package: test/stamp-links.test.ts runs these functions for real, and
// packages/seal's own tests pin what they compute.
export interface ServerKeys {
  n: number;
  mac: CryptoKey;
  runSign: unknown;
}
export function isUlid(s: string): boolean;
export function serverKeys(secret: Uint8Array, n: number): Promise<ServerKeys>;
export function linkMac(
  k: ServerKeys,
  budgetId: string,
  linkId: string,
  itemId: string,
  tokenCiphertext: Uint8Array,
): Promise<Uint8Array>;
export function checkLinkMac(
  k: ServerKeys,
  budgetId: string,
  linkId: string,
  itemId: string,
  tokenCiphertext: Uint8Array,
  mac: Uint8Array,
): Promise<boolean>;
