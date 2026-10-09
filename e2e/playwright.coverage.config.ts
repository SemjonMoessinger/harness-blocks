/**
 * The regular config with coverage switched on, for `npm run test:coverage`. The variable is set
 * here rather than as `COVERAGE=1 playwright test` in package.json, which cmd.exe, npm's shell on
 * Windows, cannot run. Workers inherit it from the runner.
 *
 * coverage.ts is appended to the project's own global setups, so the coverage hooks run inside
 * whatever setup and teardown the project already has (order explained in coverage.ts), and
 * playwright.config.ts needs no change.
 */

import { defineConfig } from '@playwright/test';
import config from './playwright.config.ts';

process.env.COVERAGE = '1';

const ownSetups = config.globalSetup === undefined ? [] : [config.globalSetup].flat();

export default defineConfig(config, {
  globalSetup: [...ownSetups, './coverage.ts'],
});
