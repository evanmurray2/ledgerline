import type { PlaywrightTestConfig } from '@playwright/test';

// What a failed test leaves behind. CI uploads e2e/playwright-report when a run fails (ci.yml): an HTML report per
// suite with the error, a screenshot of the page and a trace (every request, console line and DOM step; open it at
// trace.playwright.dev). Each suite writes its own folders, so the Worker job's two suites don't overwrite each other.
export function failureReport(suite: string): Pick<PlaywrightTestConfig, 'reporter' | 'outputDir'> & {
  use: { trace: 'retain-on-failure'; screenshot: 'only-on-failure' };
} {
  return {
    reporter: process.env.CI
      ? [['list'], ['html', { open: 'never', outputFolder: `playwright-report/${suite}` }]]
      : [['list']],
    outputDir: `test-results/${suite}`,
    use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  };
}
