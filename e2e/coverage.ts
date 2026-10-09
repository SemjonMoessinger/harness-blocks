/**
 * Which frontend code an e2e run executes, collected as V8 coverage in Chromium and mapped back to
 * the TypeScript sources through the dev server's inline source maps.
 *
 * Opt-in (`npm run test:coverage`), because it only works against a dev server: a production
 * build ships no source maps, so its coverage could not be traced to a single .ts file. A run
 * against such a build stops at the first page instead of reporting every file at 0 %.
 *
 * The specs never touch this file: fixtures.ts starts and stops the collection around every page,
 * and the global setup at the bottom clears the previous run's report and writes the new one.
 * backend-coverage.ts adds the backend's numbers to the same run when a JaCoCo agent answers.
 */

import { existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { FullConfig } from '@playwright/test';
import { CoverageReport, type CoverageReportOptions, type V8CoverageEntry } from 'monocart-coverage-reports';
import { resetBackendCoverage, writeBackendCoverageReport } from './backend-coverage.ts';
import {
  FRONTEND_DEV_SERVER_COMMAND,
  FRONTEND_REPORT_DIR,
  FRONTEND_SOURCE_DIR,
  FRONTEND_SOURCE_EXTENSIONS,
  REPO_ROOT,
  isFrontendSource,
} from './project.ts';

export const COVERAGE_ENABLED = process.env.COVERAGE === '1';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Source maps name sources relative to the frontend project ("src/app/…"), sometimes behind the dev
 * server's host ("localhost-4200/src/app/…"). Both are made FRONTEND_SOURCE_DIR-relative by
 * recognising its last segment ("src"); a dev server that names them differently shows up as an
 * lcov.info with no `SF:<FRONTEND_SOURCE_DIR>…` entries.
 */
const SOURCE_DIR_NAME = basename(FRONTEND_SOURCE_DIR.replace(/\/$/, ''));
const SOURCE_MAP_PREFIX = new RegExp(`^(?:[^/]+/)?${escapeRegExp(SOURCE_DIR_NAME)}/`);

/**
 * A URL the dev server serves as a script: a bundled `.js` chunk, or a source module under its own
 * name (Vite serves `/src/main.tsx` as JavaScript under that URL).
 */
const SCRIPT_URL = new RegExp(
  `\\.(m?js|${FRONTEND_SOURCE_EXTENSIONS.map((extension) => escapeRegExp(extension.slice(1))).join('|')})$`,
);

/**
 * What ts.transpileModule can turn into plain JavaScript for the `all` pass below. A source kind
 * outside this set (.vue, .svelte) is still measured once a page loaded it, but a file of that kind
 * no spec ever reached is missing from the report rather than listed at 0 %.
 */
const TRANSPILABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

const OPTIONS: CoverageReportOptions = {
  name: 'Frontend, e2e',
  outputDir: FRONTEND_REPORT_DIR,
  // Paths relative to the repo root, so lcov.info names files exactly as `git diff` does.
  baseDir: REPO_ROOT,
  // v8: the HTML report for humans; lcovonly: what coverage-gaps.ts reads; json-summary: totals for CI.
  reports: [['v8'], ['lcovonly'], ['json-summary'], ['console-summary']],

  sourcePath: (path: string) => path.replace(SOURCE_MAP_PREFIX, FRONTEND_SOURCE_DIR),
  sourceFilter: isFrontendSource,

  // A component no spec ever renders never reaches the browser, and a file missing from the
  // report reads as "nothing to say" rather than "0 % covered". So every source file goes in, the
  // untouched ones with empty coverage. Acorn cannot parse TypeScript or decorators, hence the
  // transpile; its source map keeps the line numbers pointing at the .ts file.
  all: {
    dir: [`${REPO_ROOT}${FRONTEND_SOURCE_DIR}`],
    // Only the file kinds here (FRONTEND_SOURCE_EXTENSIONS, the transpilable ones); isFrontendSource
    // decides which files count.
    filter: {
      ...Object.fromEntries(
        FRONTEND_SOURCE_EXTENSIONS.filter((extension) => TRANSPILABLE.has(extension)).map((extension) => [`**/*${extension}`, 'js']),
      ),
      '**': false,
    },
    transformer: async (entry: { url: string; source: string; sourceMap?: unknown }) => {
      const { outputText, sourceMapText } = ts.transpileModule(entry.source, {
        fileName: basename(entry.url),
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          // The output is only parsed, never run, so the classic JSX factory is good enough.
          jsx: ts.JsxEmit.React,
          sourceMap: true,
          // Without the original text in the map, the report drops the file altogether.
          inlineSources: true,
        },
      });
      // The map names its source by bare file name, which the report would resolve against the
      // working directory (e2e/) and then filter out as a file outside the frontend sources.
      const sourceMap = JSON.parse(sourceMapText ?? '{}') as { sources?: string[] };
      sourceMap.sources = [fileURLToPath(entry.url)];
      entry.source = outputText.replace(/\/\/# sourceMappingURL=.*$/m, '');
      entry.sourceMap = sourceMap;
    },
  },
};

/**
 * The application's own scripts. An identity provider's login page may run in the same browser,
 * and a Vite-based dev server also serves its client and the pre-bundled dependencies
 * (/@fs/…, /@vite/…); none of that is ours.
 */
function isAppScript(entry: V8CoverageEntry, frontendOrigin: string): boolean {
  return isOwnScript(entry, frontendOrigin) && SCRIPT_URL.test(new URL(entry.url).pathname);
}

/** From the frontend origin and not the dev server's own client: "/@" is Vite's client and its pre-bundled dependencies (Angular >= 17 included); a webpack dev server has no such prefix and nothing to exclude. */
function isOwnScript(entry: V8CoverageEntry, frontendOrigin: string): boolean {
  const url = new URL(entry.url);
  return url.origin === frontendOrigin && !url.pathname.startsWith('/@');
}

/**
 * Called once per page, before it closes; the report merges every page's data at the end.
 *
 * A script without a source map cannot be traced to a .ts file. A bundler's shared helper chunk
 * is one, harmlessly; but when none of the app's scripts carries a map, the run is aimed at a
 * production build, and carrying on would report every file at 0 %.
 */
export async function collectCoverage(entries: V8CoverageEntry[], frontendOrigin: string): Promise<void> {
  const appScripts = entries.filter((entry) => isAppScript(entry, frontendOrigin));
  // Scripts from the app that no extension matched would otherwise vanish without a word, and the
  // report would read as "nothing to say" — the Vite case, when FRONTEND_SOURCE_EXTENSIONS lacks the name.
  const own = entries.filter((entry) => isOwnScript(entry, frontendOrigin));
  if (own.length > 0 && appScripts.length === 0) {
    throw new Error(
      `COVERAGE=1, but none of the ${own.length} script(s) from ${frontendOrigin} ends in .js or in one of ` +
        `FRONTEND_SOURCE_EXTENSIONS (project.ts) — the first is ${own[0]?.url}. Add the extension the dev server serves sources under.`,
    );
  }
  const mapped = appScripts.filter((entry) => entry.source?.includes('//# sourceMappingURL='));
  if (appScripts.length > 0 && mapped.length === 0) {
    throw new Error(
      `COVERAGE=1, but no script from ${frontendOrigin} carries a source map. Coverage needs the ` +
        `dev server (${FRONTEND_DEV_SERVER_COMMAND}), not a production build.`,
    );
  }
  if (mapped.length > 0) await new CoverageReport(OPTIONS).add(mapped);
}

/**
 * The whole report directory, not only the collected data: a run that collects nothing must not
 * leave the previous run's lcov.info behind for coverage-gaps.ts to read.
 */
function discardPreviousCoverage(): void {
  rmSync(FRONTEND_REPORT_DIR, { recursive: true, force: true });
}

async function writeCoverageReport(): Promise<void> {
  await new CoverageReport(OPTIONS).generate();
  const html = `${FRONTEND_REPORT_DIR}index.html`;
  if (existsSync(html)) console.log(`Frontend report: ${pathToFileURL(html).href}`);
}

/**
 * Playwright global setup, appended by playwright.coverage.config.ts after the project's own. It
 * therefore runs after the project's setup (which may reset test data), and the teardown it
 * returns runs before the project's global teardown: Playwright runs returned teardowns first and
 * globalTeardown files last. So the harness's own data resets stay out of the backend's numbers.
 *
 * Guarded by COVERAGE_ENABLED, so listing this file in playwright.config.ts's globalSetup as well
 * is harmless and makes `COVERAGE=1` work on any Playwright command.
 */
export default async function coverageGlobalSetup(config: FullConfig): Promise<(() => Promise<void>) | undefined> {
  if (!COVERAGE_ENABLED) return undefined;
  discardPreviousCoverage();
  await resetBackendCoverage(config.projects[0]?.use.baseURL);
  return async () => {
    await writeCoverageReport();
    await writeBackendCoverageReport();
  };
}
