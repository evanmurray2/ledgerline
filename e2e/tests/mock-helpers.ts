// Shared steps for the mock suite (playwright.config.ts): the SPA with every /api request answered in memory.
import { test, type Page } from '@playwright/test';

/** Ready to Assign: the bottom bar on a phone, the sidebar on desktop. */
export function rta(page: Page) {
  return page.getByTestId(test.info().project.name === 'desktop' ? 'nav-rta' : 'rta');
}
