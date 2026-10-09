/**
 * Browser flows shared by the specs, the screenshot harness (shot.ts) and the local seeder
 * (seed.ts): one copy of every step that drives one of the app's forms, so a renamed field breaks
 * in one place instead of five.
 *
 * These only drive the forms — they assert nothing. A spec that calls a step here still tests the
 * app's own flow; the step just types into it. What a step may throw on is a precondition the
 * caller cannot see, such as a record that already exists under the name asked for. Assertions
 * stay in the specs, and a step that fills a form deliberately does not submit it when a spec
 * wants to assert something between filling and submitting.
 *
 * Two runtimes share this file: the specs go through the Playwright runner, shot.ts and seed.ts
 * through plain `node`, which strips types natively (Node >= 23.6) without checking them. Hence:
 *
 *   - Nothing here may import a *value* from @playwright/test. `Page` comes in as `import type`,
 *     which is erased before node sees it, and waits use `locator.waitFor()` rather than `expect()`.
 *   - `npm run typecheck` is the only thing that checks this file — node will happily run a type
 *     error. Run it after every change in here.
 *
 * The login itself lives in login.ts, which follows the same rules.
 */

import type { Page } from '@playwright/test';

/** How long a step waits for the app to answer; generous, because a cold dev server is slow. */
export const STEP_TIMEOUT = 30_000;

// ADAPT: replace the example entity and step below with the forms your specs and seed.ts drive, one exported step per form.
export interface Project {
  name: string;
  description?: string;
}

/**
 * Creates a project through the UI and leaves the page on its detail view. The example of what a
 * step looks like: reached from a known route, filled by label, submitted, and settled by waiting
 * for what the app renders next — never by a fixed sleep.
 */
export async function createProject(page: Page, { name, description = '' }: Project): Promise<void> {
  await page.goto('/projects/new');
  await page.getByLabel('Name').fill(name);
  if (description) await page.getByLabel('Description').fill(description);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('heading', { name }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
}
