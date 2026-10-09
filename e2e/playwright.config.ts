import { defineConfig, devices } from '@playwright/test';
// The one address the suite depends on, shared with every script: DEFAULT_BASE_URL in project.ts,
// overridden per machine or stack by the BASE_URL variable.
import { BASE_URL } from './project.ts';

export default defineConfig({
  testDir: './tests',
  // The test accounts are reset before and after every run, see test-accounts.ts.
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['html']],
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
