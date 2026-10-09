import type { FullConfig } from '@playwright/test';
import { baseUrlOf, resetTestAccounts } from './test-accounts.ts';

/**
 * Every run starts from the same accounts: none. This, not the teardown, is what makes a run
 * independent of the one before it — the teardown does not run when the job is cancelled or
 * times out.
 *
 * Coverage (coverage.ts) hooks in after this through playwright.coverage.config.ts, so the reset
 * here stays out of the coverage numbers.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  await resetTestAccounts(baseUrlOf(config));
}
