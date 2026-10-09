/**
 * The `test` every spec imports instead of @playwright/test's, so that coverage.ts sees every page
 * a spec opens. An ESLint no-restricted-imports rule on the specs is the cheap way to keep it so,
 * together with one against hand-made contexts (`browser.newContext()`).
 *
 * `newSession` is for the specs that need several logins side by side: each call is a context of
 * its own, i.e. its own cookies and login session, closed again after the test. A page from a
 * hand-made `browser.newContext()` would drop out of the coverage report unnoticed.
 *
 * Still out of reach: popups, pages from `context.newPage()`, and a page the spec closes itself,
 * whose counters are gone before the fixture can read them.
 */

import { test as base, type Page } from '@playwright/test';
import { COVERAGE_ENABLED, collectCoverage } from './coverage.ts';

export { expect } from '@playwright/test';

interface Fixtures {
  newSession: () => Promise<Page>;
}

async function startCoverage(page: Page): Promise<void> {
  // resetOnNavigation off: a full reload in the middle of a spec would otherwise throw away the
  // counts of everything before it.
  if (COVERAGE_ENABLED) await page.coverage.startJSCoverage({ resetOnNavigation: false });
}

async function stopCoverage(page: Page, baseURL: string | undefined): Promise<void> {
  if (!COVERAGE_ENABLED || page.isClosed()) return;
  if (!baseURL) throw new Error('playwright.config.ts sets no baseURL');
  await collectCoverage(await page.coverage.stopJSCoverage(), new URL(baseURL).origin);
}

export const test = base.extend<Fixtures>({
  page: async ({ page, baseURL }, use) => {
    await startCoverage(page);
    await use(page);
    await stopCoverage(page, baseURL);
  },

  newSession: async ({ browser, baseURL, contextOptions }, use) => {
    const pages: Page[] = [];
    await use(async () => {
      // contextOptions carries the project's `use` block (baseURL, viewport, device): a bare
      // browser.newContext() would have none of it, and the first relative goto('/') would throw.
      const page = await (await browser.newContext(contextOptions)).newPage();
      await startCoverage(page);
      pages.push(page);
      return page;
    });
    // Every context gets closed, even when collecting one page's coverage fails.
    const failures: unknown[] = [];
    for (const page of pages) {
      await stopCoverage(page, baseURL).catch((failure: unknown) => failures.push(failure));
      await page.context().close();
    }
    if (failures.length > 0) throw failures[0];
  },
});
