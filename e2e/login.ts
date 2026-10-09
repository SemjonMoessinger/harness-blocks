/**
 * The one place that knows how this app logs a user in. shot.ts, seed.ts and the specs import
 * their auth from here and from nowhere else, so swapping the login — a different form, an identity
 * provider, a magic link — is a change to this file alone.
 *
 * Plain node runs this file as well as the Playwright runner (see flows.ts), so `Page` comes in
 * as `import type` and waits use `locator.waitFor()`, never `expect()`.
 *
 * The reference implementation below drives a generic username/password form reached from the
 * home page. Everything marked ADAPT is the part to replace; the shape of the four exports is what
 * the rest of the harness relies on.
 */

import type { Locator, Page } from '@playwright/test';

export interface TestUser {
  username: string;
  password: string;
}

/**
 * True for an application without any login. Every shot is then anonymous and reports
 * `session none`, seed.ts refuses to run, the suite resets no accounts and the smoke spec skips
 * its login test. The rest of this file stays inert: delete its remaining ADAPT markers instead
 * of working them.
 */
// ADAPT: set true if this app has no login at all; otherwise leave false and work the markers below.
export const NO_LOGIN = false;
// Everything from here on describes and drives a login; with NO_LOGIN it is never called.

/**
 * The account every authenticated shot and the smoke spec use unless E2E_USER / E2E_PASSWORD say
 * otherwise. It has to exist before anything runs; seed.ts completes it, it never creates it.
 */
export const DEFAULT_USER: TestUser = {
  // ADAPT: set the username and password of the standing test account of your local stack (never a production login).
  username: process.env.E2E_USER ?? 'e2e-user@example.com',
  password: process.env.E2E_PASSWORD ?? 'change-me',
};

/** Long enough for a redirect-based login with several round trips, short enough to fail a dead stack fast. */
export const LOGIN_TIMEOUT = 20_000;

/**
 * The two header states, one of which the app renders once it has decided whether the visitor is
 * signed in. Both are needed: `isLoggedIn` races them, and `login` waits for the first.
 */
// ADAPT: point both locators at whatever your header renders for a signed-in and a signed-out visitor at desktop width.
function loggedInMarker(page: Page): Locator {
  return page.getByRole('button', { name: 'Log out' });
}

function loggedOutMarker(page: Page): Locator {
  return page.getByRole('button', { name: 'Log in' });
}

/**
 * Signs `user` in from the home page and returns once the app shows them as signed in. Where the
 * app sends them afterwards is the caller's business.
 *
 * Callers run this at desktop width (shot.ts sets the viewport before calling): below the mobile
 * breakpoint the login and logout controls of most headers collapse into a burger menu, and the
 * login is plumbing rather than the thing under test. The locators here may assume that.
 */
export async function login(page: Page, user: TestUser): Promise<void> {
  await page.goto('/');
  // ADAPT: replace these steps with the way your app reaches and fills its login form (an identity provider's hosted form included).
  await loggedOutMarker(page).click();
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await loggedInMarker(page)
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT })
    .catch(() => {
      throw new Error(
        `login as ${user.username} never reached the signed-in state — does that account exist on the stack this run points at?`,
      );
    });
}

/**
 * Whether the page currently shows a signed-in visitor.
 *
 * Races both header states rather than sampling one: `locator.isVisible()` is a point-in-time
 * check with no wait, and called right after `load` it reports "logged out" before the app has
 * resolved its auth state — a restored session resolves it via a silent round trip. Racing the
 * two locators waits for that decision instead of sampling the DOM before it has been made.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  return Promise.race([
    loggedInMarker(page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT }).then(() => true),
    loggedOutMarker(page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT }).then(() => false),
  ]).catch(() => false);
}

/** The file-name stem of a user's cached session under .auth/: one file per login, never shared. */
export function sessionSlug(user: TestUser): string {
  return user.username.replace(/[^a-zA-Z0-9]+/g, '-');
}
