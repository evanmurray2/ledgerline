// Which suite runs each spec file in e2e/tests, by exact file name: every config takes its list from here, so a new
// spec lands in the suite it is listed under, never in another by a look-alike name. Loading a config checks that
// each spec file is in exactly one list, and fails the run if not: list a new spec file here.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SUITES = {
  /** The SPA in mock mode (playwright.config.ts). */
  mock: [
    'accounts.spec.ts',
    'activity.spec.ts',
    'add.spec.ts',
    'back.spec.ts',
    'budget.spec.ts',
    'budget-desktop.spec.ts',
    'categories.spec.ts',
    'layout.spec.ts',
    'navigation.spec.ts',
    'payees.spec.ts',
    'read-only.spec.ts',
    'same-purchase.spec.ts',
    'screenshots.spec.ts',
    'settings.spec.ts',
    'targets.spec.ts',
  ],
  /** Passkey sign-in through the real Worker (playwright.passkey.config.ts). */
  passkey: ['passkey.spec.ts'],
  /** Open sign-up through the real Worker (playwright.signup.config.ts). */
  signup: ['signup.spec.ts', 'sweep-signup.spec.ts'],
  /** A new locked budget and its screens through the real Worker (playwright.lock.config.ts). */
  lock: ['lock.spec.ts', 'screens-lock.spec.ts'],
  /** A linked bank on the fake Plaid through the real Worker (playwright.bank.config.ts). */
  bank: ['banks.spec.ts'],
} as const;

export type Suite = keyof typeof SUITES;

const TESTS = fileURLToPath(new URL('./tests', import.meta.url));

/** What is wrong with the lists: a spec file in no suite or in two, or a listed file that isn't there. */
export function suiteProblems(files: readonly string[] = readdirSync(TESTS)): string[] {
  const specs = files.filter((f) => f.endsWith('.spec.ts'));
  const problems: string[] = [];
  for (const f of specs) {
    const in_ = (Object.keys(SUITES) as Suite[]).filter((s) => (SUITES[s] as readonly string[]).includes(f));
    if (in_.length === 0) problems.push(`${f} is in no suite`);
    if (in_.length > 1) problems.push(`${f} is in ${in_.join(' and ')}`);
  }
  for (const s of Object.keys(SUITES) as Suite[])
    for (const f of SUITES[s]) if (!specs.includes(f)) problems.push(`${f} (${s}) is not in e2e/tests`);
  return problems;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `testMatch` of a suite's config: its files by exact name. Throws when a spec file is in no suite or two. */
export function suiteFiles(suite: Suite): RegExp {
  const problems = suiteProblems();
  if (problems.length) throw new Error(`e2e/suites.ts: ${problems.join('; ')}`);
  return new RegExp(`[\\\\/]tests[\\\\/](${SUITES[suite].map(escape).join('|')})$`);
}
