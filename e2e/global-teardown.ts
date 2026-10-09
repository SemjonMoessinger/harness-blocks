import type { FullConfig } from '@playwright/test';
import { baseUrlOf, resetTestAccounts } from './test-accounts.ts';

/**
 * Leaves nothing of this run on the stack, failed run or not.
 *
 * Reported rather than thrown: the next run's setup resets the same accounts and does fail
 * loudly, so a teardown that meets a briefly unreachable stack must not turn a green run red.
 */
export default async function globalTeardown(config: FullConfig): Promise<void> {
  await resetTestAccounts(baseUrlOf(config)).catch((failure: unknown) => {
    console.warn(`e2e teardown could not reset the test accounts: ${String(failure)}`);
  });
}
