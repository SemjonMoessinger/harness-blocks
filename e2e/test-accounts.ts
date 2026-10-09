/**
 * Puts the suite's test accounts back to "first contact" before and after every run, so that a
 * run starts from accounts that do not exist as far as the application is concerned, and a failed
 * run leaves nothing behind for the next one.
 *
 * The login itself stays: only the application's own state of the account — profile, records,
 * settings — is erased. The account deletion a UI offers usually cannot do this, because it
 * deletes the login too and a test account that has to be recreated by hand is one that soon will
 * not be. A dedicated reset endpoint, enabled on local and dev stacks only, is the usual answer.
 *
 * Optional: with no reset configured (E2E_RESET_URL unset), the reset is a no-op that says so once.
 * The suite then still runs, but its specs have to cope with whatever the accounts carry.
 *
 * Plain node, like flows.ts: global-setup.ts, global-teardown.ts and the specs all call it.
 */

import type { FullConfig } from '@playwright/test';
import { DEFAULT_USER, NO_LOGIN, type TestUser } from './login.ts';
import { isLocal } from './project.ts';

/**
 * Every account the suite resets. Whether DEFAULT_USER belongs here is a decision: shot.ts
 * relies on the state seed.ts gives that account, and a suite run would take it away again.
 */
// ADAPT: list the accounts your specs log in as (each must exist on every stack the suite runs against), and decide whether DEFAULT_USER is among them.
export const TEST_ACCOUNTS: readonly TestUser[] = NO_LOGIN ? [] : [DEFAULT_USER];

let announcedNoop = false;

/**
 * Reference implementation: one request per account to a reset endpoint named by E2E_RESET_URL,
 * authenticated with E2E_RESET_TOKEN. The endpoint is expected to answer 204.
 */
// ADAPT: implement the reset your backend offers (a DELETE with the account's own token, a CLI, a database script), or keep the no-op and drop the endpoint code.
export async function resetTestAccount(baseUrl: string, account: TestUser): Promise<void> {
  const url = process.env.E2E_RESET_URL;
  if (!url) {
    if (!announcedNoop) console.warn('E2E_RESET_URL is not set — the test accounts are not reset between runs.');
    announcedNoop = true;
    return;
  }
  if (!isLocal(baseUrl) && !process.env.E2E_RESET_TOKEN) {
    throw new Error(`refusing to reset ${account.username} on ${baseUrl} without E2E_RESET_TOKEN`);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.E2E_RESET_TOKEN) headers.Authorization = `Bearer ${process.env.E2E_RESET_TOKEN}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: account.username }),
  });
  if (response.status === 204) return;

  const cause: Record<number, string> = {
    401: 'the backend rejects the token',
    403: `${account.username} may not be reset by this token`,
    404: 'the backend has no reset endpoint — is it enabled on this stack, or does it run an older build?',
  };
  throw new Error(
    `resetting ${account.username} at ${url} answered ${response.status}: ${cause[response.status] ?? 'unexpected'}.`,
  );
}

export async function resetTestAccounts(baseUrl: string): Promise<void> {
  if (TEST_ACCOUNTS.length === 0) {
    if (!announcedNoop) console.warn('no test accounts to reset (TEST_ACCOUNTS is empty); nothing is reset between runs.');
    announcedNoop = true;
    return;
  }
  await Promise.all(TEST_ACCOUNTS.map((account) => resetTestAccount(baseUrl, account)));
}

/** The target the run points at, as playwright.config.ts resolved it. */
export function baseUrlOf(config: FullConfig): string {
  const baseUrl = config.projects[0]?.use.baseURL;
  if (!baseUrl) throw new Error('playwright.config.ts sets no baseURL');
  return baseUrl;
}
