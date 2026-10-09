#!/usr/bin/env node
/**
 * Seeds the LOCAL dev stack with valid accounts by driving the real registration flow — the same
 * flow the specs assert on, sharing its steps via flows.ts. Two things fall out of that:
 *
 *   1. After wiping the local database you get usable data back with one command.
 *   2. Running it regularly is a local check that registration still works.
 *
 * It also completes DEFAULT_USER, because that is the account shot.ts logs in as: without the
 * state the authenticated routes assume, every screenshot of one shows a guard's page instead of
 * the route asked for (the `assumes` line of the report).
 *
 *   npm run seed
 *   npm run seed -- --count=5
 *   npm run seed -- --count=0 --skip-default
 *
 * The registration and completion steps are the part to adapt; the safety net around them —
 * local stack only, a fresh browser context per account, the login line printed at the end — is
 * the part to keep.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { parseFlags } from './cli.ts';
import { DEFAULT_USER, NO_LOGIN, isLoggedIn, login, type TestUser } from './login.ts';
import { createProject, STEP_TIMEOUT } from './flows.ts';
import { BASE_URL, FRONTEND_DEV_SERVER_COMMAND, isLocal } from './project.ts';

/** Wide enough for the longest seeded username, so the report lines up. */
const USERNAME_COLUMN = 40;

// ADAPT: a password your registration form's policy accepts; it is printed at the end, so it must not be a real one.
const SEED_PASSWORD = 'Seeded-Account-1!';

interface SeedOptions {
  count: number;
  skipDefault: boolean;
  headed: boolean;
}

function parseArgs(argv: string[]): SeedOptions {
  const { flags } = parseFlags(argv);
  return {
    count: Number(flags.count ?? 1),
    skipDefault: flags['skip-default'] === true,
    headed: flags.headed === true,
  };
}

/**
 * Seeding the wrong database silently would be the worst possible failure, so refuse rather than
 * guess. Two checks: the host has to be this machine, and what answers there has to be the dev
 * server rather than a deployed stack that happens to publish the same port. The discriminator
 * for the second is the `Server` header — a dev server sends none, nginx does.
 */
async function assertLocalDevServer(): Promise<void> {
  if (!isLocal(BASE_URL)) {
    throw new Error(`${BASE_URL} is not a local stack — seed.ts only ever writes to this machine`);
  }

  // With a timeout: a sandbox firewall DROPs rather than refuses, and a hanging fetch would say nothing.
  const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!response) {
    throw new Error(`nothing answers on ${BASE_URL} — start the dev server (${FRONTEND_DEV_SERVER_COMMAND})`);
  }

  // ADAPT: if a containerised stack on this machine can publish the same port as the dev server, keep a check that tells the two apart; otherwise drop it.
  const server = response.headers.get('server') ?? '';
  if (/nginx/i.test(server)) {
    throw new Error(
      `${BASE_URL} is served by nginx, which means a packaged stack rather than the dev server — ` +
        `seeding it would write to the wrong database. Stop that stack first, or set BASE_URL explicitly.`,
    );
  }
}

async function withPage<T>(browser: Browser, fn: (page: Page) => Promise<T>): Promise<T> {
  // A fresh context per account: sessions must not bleed between registrations.
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 800 } });
  try {
    return await fn(await context.newPage());
  } finally {
    await context.close();
  }
}

interface SeedRun {
  index: number;
  stamp: number;
}

interface Person extends TestUser {
  displayName: string;
}

/**
 * Registers one account through the UI and returns its login. Reference implementation for a
 * generic sign-up form; the check at the end is what makes a silently failed registration fail
 * the seed by name instead of surfacing three steps later.
 */
async function registerAccount(page: Page, { index, stamp }: SeedRun): Promise<TestUser> {
  const person: Person = {
    displayName: `Seed ${stamp}-${index}`,
    // A single stamp per run keeps one run's users recognisable as a batch.
    username: `seed-${stamp}-${index}@example.com`,
    password: SEED_PASSWORD,
  };

  // ADAPT: drive your registration flow here (and any onboarding step the app insists on afterwards), through steps in flows.ts.
  await page.goto('/register');
  await page.getByLabel('Name').fill(person.displayName);
  await page.getByLabel('E-mail').fill(person.username);
  await page.getByLabel('Password').fill(person.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForLoadState('networkidle', { timeout: STEP_TIMEOUT }).catch(() => undefined);

  if (!(await isLoggedIn(page))) {
    throw new Error(`registering ${person.username} did not end in a signed-in session; the page is at ${page.url()}`);
  }
  return person;
}

/**
 * Brings DEFAULT_USER into the state the authenticated routes assume. Logs in rather than
 * registering: the account already exists, seed.ts completes it and creates nothing under its name.
 */
async function completeDefaultUser(page: Page): Promise<void> {
  await login(page, DEFAULT_USER);
  // ADAPT: give the default account whatever the authenticated routes need to render with data (a profile, a first record); an account that already has it should pass through unchanged.
  await createProject(page, { name: `Seeded project ${Date.now()}` });
}

function plan({ count, skipDefault }: SeedOptions): string {
  const parts = [`${count} account(s)`];
  if (!skipDefault) parts.push(`${DEFAULT_USER.username} completed`);
  return parts.join(' + ');
}

async function main() {
  if (NO_LOGIN) {
    throw new Error(
      'this app has no login (NO_LOGIN in login.ts), so there are no accounts to register or complete. ' +
        'Delete seed.ts and its npm script, or rewrite it around what this app calls test data.',
    );
  }
  const opts = parseArgs(process.argv.slice(2));
  await assertLocalDevServer();

  console.log(`seeding ${BASE_URL} — ${plan(opts)}\n`);

  const browser = await chromium.launch({ headless: !opts.headed });
  const stamp = Date.now();
  const created: TestUser[] = [];

  try {
    for (let index = 0; index < opts.count; index++) {
      const account = await withPage(browser, page => registerAccount(page, { index, stamp }));
      created.push(account);
      console.log(`  ✓ ${account.username.padEnd(USERNAME_COLUMN)} registered`);
    }

    if (!opts.skipDefault) {
      await withPage(browser, completeDefaultUser);
      console.log(`  ✓ ${DEFAULT_USER.username.padEnd(USERNAME_COLUMN)} ready`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\ndone. Password for the seeded accounts: ${SEED_PASSWORD}`);

  // The line an agent copies to look at a route as one of the accounts just made — the session
  // cache of shot.ts is keyed by login, so this never serves the default user's page by mistake.
  const first = created[0];
  if (first) {
    console.log(
      `\nto look at a route as a seeded account:\n` +
        `  E2E_USER=${first.username} E2E_PASSWORD=${first.password} npm run shot --prefix e2e -- /dashboard`,
    );
  }
}

main().catch(err => {
  console.error(`\nseed failed: ${err.message}`);
  process.exit(1);
});
