#!/usr/bin/env node
/**
 * Checks the environment the harness runs in and how far its adoption has come, one line per
 * check. It answers the questions an adopting agent would otherwise have to remember: is node new
 * enough, is Chromium installed, does BASE_URL answer and is it this app, are the harness's
 * outputs gitignored (and its own files not), does the root agent file exist, does something else
 * already answer on the JaCoCo port, and which ADAPT markers are left.
 *
 *   npm run doctor
 *
 * `✗` is a failure the next step will trip over (exit code 1), `!` something to decide or confirm,
 * `✓` fine. Nothing here changes anything.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { chromium } from 'playwright';
import { portAnswers } from './backend-coverage.ts';
import { DEFAULT_USER, NO_LOGIN } from './login.ts';
import {
  BACKEND_DIR,
  BACKEND_PRESENT,
  BASE_URL,
  DEFAULT_BASE_URL,
  FRONTEND_SOURCE_DIR,
  JACOCO_AGENT_PORT,
  REPO_ROOT,
} from './project.ts';

const MIN_NODE = [23, 6] as const;
/** Written by the harness, must be ignored. */
const MUST_BE_IGNORED = ['e2e/.auth/x', 'e2e/tmp/x', 'e2e/coverage/x', 'tmp/shots/x'];
/** Part of the harness, must not be swallowed by a pre-existing rule such as Angular's `e2e/*.js`. */
const MUST_NOT_BE_IGNORED = ['e2e/eslint.config.js', 'e2e/shot.ts', 'e2e/package.json'];
const SKILL_DIRS = ['.claude/skills', '.agents/skills'];
/** Where ADAPT markers may live once the blocks are installed: the harness, the skills, the CI template. */
const MARKER_DIRS = ['e2e', ...SKILL_DIRS, '.github/workflows'];
/** Directories the marker scan never enters, and the one file that documents the markers without carrying any. */
const MARKER_SKIP_DIRS = new Set(['node_modules', 'adopt-harness', '.auth', 'tmp', 'coverage']);
const MARKER_SKIP_FILES = new Set(['doctor.ts']);
const MARKER_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.md', '.json', '.yml', '.yaml']);
/** A real marker: a comment that begins with ADAPT:. Prose that mentions the word does not count. */
const MARKER = /(\/\/|\*|<!--|#) *ADAPT:\s*(.*)$/;
const FETCH_TIMEOUT = 5_000;

let failed = false;

function ok(text: string): void {
  console.log(`✓ ${text}`);
}
function decide(text: string): void {
  console.log(`! ${text}`);
}
function fail(text: string): void {
  failed = true;
  console.log(`✗ ${text}`);
}

function git(...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '' };
}

function checkNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const enough = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  if (enough) ok(`node ${process.versions.node} (>= ${MIN_NODE.join('.')}, strips types natively)`);
  else fail(`node ${process.versions.node} is older than ${MIN_NODE.join('.')}; the scripts need native type stripping`);
}

function checkChromium(): void {
  const path = chromium.executablePath();
  if (existsSync(path)) ok('Chromium for Playwright is installed');
  else fail('Chromium for Playwright is missing: cd e2e && npx playwright install chromium');
}

async function checkDevServer(): Promise<void> {
  const overridden = BASE_URL !== DEFAULT_BASE_URL;
  // With a timeout: a sandbox firewall DROPs rather than refuses, and a hanging fetch would print nothing.
  const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }).catch(() => null);
  if (!response) {
    fail(
      `nothing answers on ${BASE_URL}${overridden ? ' (BASE_URL)' : ' (DEFAULT_BASE_URL in project.ts)'}; ` +
        'start the dev server, or set BASE_URL to where it runs',
    );
    return;
  }
  const html = await response.text().catch(() => '');
  const served = titleOf(html);
  const server = response.headers.get('server');
  const where = `${BASE_URL} answers ${response.status}${overridden ? ' (BASE_URL overrides the project default)' : ''}`;

  // Another project's dev server on the same port looks just as green; its <title> gives it away,
  // compared with what this project's own index.html says.
  const indexHtml = `${REPO_ROOT}${FRONTEND_SOURCE_DIR}index.html`;
  const own = existsSync(indexHtml) ? titleOf(readFileSync(indexHtml, 'utf8')) : null;
  if (own === null) {
    ok(`${where}, title "${served}"`);
    decide(`no ${FRONTEND_SOURCE_DIR}index.html to compare that title with (FRONTEND_SOURCE_DIR in project.ts); confirm it is THIS app`);
  } else if (own === served) {
    ok(`${where}, title "${served}" matches ${FRONTEND_SOURCE_DIR}index.html`);
  } else {
    fail(
      `${where}, but its title "${served}" is not this project's ("${own}" in ${FRONTEND_SOURCE_DIR}index.html): ` +
        'another project\'s server on that port? Point BASE_URL at where this app runs',
    );
  }
  if (server && /nginx/i.test(server)) decide(`${BASE_URL} is served by nginx, a packaged stack rather than the dev server (no source maps, no live reload)`);
}

function titleOf(html: string): string {
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '(no <title>)';
}

function checkGitignore(): void {
  if (git('rev-parse', '--is-inside-work-tree').status !== 0) {
    decide(`${REPO_ROOT} is not a git work tree; the gitignore checks are skipped`);
    return;
  }
  const notIgnored = MUST_BE_IGNORED.filter((path) => git('check-ignore', '-q', path).status !== 0);
  if (notIgnored.length === 0) ok('shots, sessions, coverage and scratch files are gitignored');
  else fail(`not gitignored: ${notIgnored.join(', ')} — e2e/.gitignore travels with e2e/, the root .gitignore needs \`tmp/\``);

  const swallowed = MUST_NOT_BE_IGNORED.filter((path) => git('check-ignore', '-q', path).status === 0);
  if (swallowed.length === 0) ok("no pre-existing ignore rule swallows the harness's own files");
  else {
    const rules = swallowed.map((path) => git('check-ignore', '-v', path).stdout.trim()).join('; ');
    fail(`ignored by a pre-existing rule and would never be committed: ${rules} — add a \`!\` exception below that rule`);
  }
}

function checkAgentFile(): void {
  const files = ['AGENTS.md', 'CLAUDE.md'].filter((name) => existsSync(`${REPO_ROOT}${name}`));
  if (files.length === 0) {
    decide('no root AGENTS.md or CLAUDE.md yet: the adoption creates one from docs/agents-md-snippet.md (skill step 4)');
    return;
  }
  const withUsers = files.filter((name) => /^#+\s+Test users/m.test(readFileSync(`${REPO_ROOT}${name}`, 'utf8')));
  if (withUsers.length > 0) ok(`${withUsers.join(', ')} has the "Test users" section the skills point at`);
  else decide(`${files.join(', ')} exists but has no "Test users" heading; paste docs/agents-md-snippet.md (skill step 4)`);
}

function checkLogin(): void {
  if (NO_LOGIN) {
    ok('login: none (NO_LOGIN in login.ts); every shot is anonymous');
    return;
  }
  if (DEFAULT_USER.password === 'change-me' || DEFAULT_USER.username.endsWith('@example.com')) {
    decide(`login: DEFAULT_USER is still the template's placeholder (${DEFAULT_USER.username}); login.ts is not adapted yet, or E2E_USER / E2E_PASSWORD are unset`);
  } else ok(`login: DEFAULT_USER is ${DEFAULT_USER.username}`);
}

async function checkJacoco(): Promise<void> {
  if (!BACKEND_PRESENT) {
    ok(`no Maven backend at ${BACKEND_DIR}; coverage measures the frontend alone`);
    return;
  }
  if (await portAnswers(JACOCO_AGENT_PORT, 500)) {
    decide(
      `something answers on the JaCoCo port :${JACOCO_AGENT_PORT}. If it is not THIS project's backend ` +
        `(lsof -iTCP:${JACOCO_AGENT_PORT} -sTCP:LISTEN), a coverage run would reset another project's counters: change JACOCO_AGENT_PORT in project.ts`,
    );
  } else ok(`JaCoCo port :${JACOCO_AGENT_PORT} is free (no backend with the agent running right now)`);
}

/** Every text file under `dir` the marker scan should read, recursively, skipping what it never enters. */
function markerFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!MARKER_SKIP_DIRS.has(entry.name)) markerFiles(path, found);
    } else if (MARKER_EXTENSIONS.has(extname(entry.name)) && !MARKER_SKIP_FILES.has(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Lists every ADAPT marker left. Done in Node rather than by shelling out to grep: a missing or
 * failing grep would print nothing, and nothing would read as "no markers left" — on Windows, say,
 * where the rest of the harness runs.
 */
function checkMarkers(): void {
  const lines: string[] = [];
  for (const dir of MARKER_DIRS.filter((d) => existsSync(`${REPO_ROOT}${d}`))) {
    for (const file of markerFiles(`${REPO_ROOT}${dir}`)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const match = MARKER.exec(line);
          if (!match) return;
          const what = (match[2] ?? '').replace(/\s*-->\s*$/, '');
          lines.push(`${relative(REPO_ROOT, file)}:${index + 1}  ${what.length > 110 ? `${what.slice(0, 109)}…` : what}`);
        });
    }
  }
  if (lines.length === 0) {
    ok('no ADAPT markers left');
    return;
  }
  decide(`${lines.length} ADAPT marker(s) left:`);
  for (const line of lines) console.log(`    ${line}`);
}

async function main(): Promise<void> {
  checkNode();
  checkChromium();
  await checkDevServer();
  checkGitignore();
  checkAgentFile();
  checkLogin();
  await checkJacoco();
  checkMarkers();
  if (failed) {
    console.log('\nfix the ✗ lines before the next step');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`doctor failed: ${err.message}`);
  process.exit(1);
});
