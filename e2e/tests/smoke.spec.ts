import { test, expect } from '../fixtures.ts';
import { DEFAULT_USER, NO_LOGIN, isLoggedIn, login } from '../login.ts';

/**
 * The spec that must stay green on every stack, the deployed one included: the home page renders,
 * and the standing test account can sign in. Deliberately not a check on *which* page the login
 * lands on: that follows the account's state in the stack's database and changes the moment
 * somebody uses the account. That a session exists at all is this spec's business.
 */
test.describe('Smoke test', () => {
  test('home loads', async ({ page }) => {
    await page.goto('/');
    // ADAPT: assert something the home page always renders for an anonymous visitor (a heading, the app's title, a navigation).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('the login works', async ({ page }) => {
    test.skip(NO_LOGIN, 'this app has no login');
    await page.goto('/');
    await login(page, DEFAULT_USER);

    // Back to the home page, which is where login.ts reads the header state from.
    await page.goto('/');
    expect(await isLoggedIn(page)).toBe(true);
  });
});
