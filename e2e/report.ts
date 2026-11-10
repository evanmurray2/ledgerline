import type { PlaywrightTestConfig } from '@playwright/test';

// What a failed test leaves behind. CI uploads e2e/playwright-report when a run fails (ci.yml): an HTML report per
// suite with the error, a screenshot of the page and a trace (every request, console line and DOM step; open it at
// trace.playwright.dev). Each suite writes its own folders, so the Worker job's suites don't overwrite each other.
// CI tries a failed test once more, so one slow moment doesn't block a deploy; retry-log.ts records each test that
// needed it, and CI uploads the report for those too.
export function failureReport(suite: string): Pick<
  PlaywrightTestConfig,
  'reporter' | 'outputDir' | 'retries'
> & {
  use: { trace: 'retain-on-failure'; screenshot: 'only-on-failure' };
} {
  return {
    reporter: process.env.CI
      ? [
          ['list'],
          ['html', { open: 'never', outputFolder: `playwright-report/${suite}` }],
          ['./retry-log.ts', { suite }],
        ]
      : [['list']],
    retries: process.env.CI ? 1 : 0,
    outputDir: `test-results/${suite}`,
    use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  };
}
