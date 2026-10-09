#!/usr/bin/env node
/**
 * Diff coverage: which of the lines changed against a base ref did the last `npm run test:coverage`
 * never execute? Meant as a feedback signal after a change, for humans and agents alike, so it
 * prints only the changed files that have gaps, as line ranges.
 *
 *   npm run coverage:gaps                  # against DEFAULT_BASE_REF (project.ts)
 *   npm run coverage:gaps -- --base main   # e.g. on a local feature branch
 *
 * The diff runs from the merge base to the working tree, so committed, staged, unstaged and
 * untracked changes all count. A renamed file counts as new in full. It reads the frontend's
 * lcov.info (coverage.ts) and the backend's jacoco.xml (backend-coverage.ts), whichever exist.
 *
 * Informational: it exits 0 whatever the gaps, and 1 only when there is no report or git cannot
 * diff against the base. A covered line only means some flow ran it, not that an assertion
 * checked it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  BACKEND_JACOCO_XML,
  BACKEND_MISMATCH_FILE,
  BACKEND_SOURCE_ROOTS,
  BACKEND_START_COMMAND,
  DEFAULT_BASE_REF,
  FRONTEND_LCOV,
  REPO_ROOT,
  isBackendSource,
  isFrontendSource,
} from './project.ts';

/** A JaCoCo package/source pair as a repo-relative path, under whichever source root holds it. */
function backendSourcePath(packagePath: string): string {
  const root = BACKEND_SOURCE_ROOTS.find((candidate) => existsSync(`${REPO_ROOT}${candidate}${packagePath}`));
  return `${root ?? BACKEND_SOURCE_ROOTS[0] ?? ''}${packagePath}`;
}

interface LineCoverage {
  hits: number;
  /** Executed, but at least one of its branches never taken. */
  partial: boolean;
}

/** Repo-relative path → line number → what the report knows about that line. */
type Coverage = Map<string, Map<number, LineCoverage>>;

interface Report {
  side: 'frontend' | 'backend';
  file: string;
  covers: (path: string) => boolean;
  coverage: Coverage;
  modifiedAt: Date;
}

function linesOf(coverage: Coverage, path: string): Map<number, LineCoverage> {
  let lines = coverage.get(path);
  if (!lines) {
    lines = new Map();
    coverage.set(path, lines);
  }
  return lines;
}

function parseLcov(content: string): Coverage {
  const coverage: Coverage = new Map();
  let lines = new Map<number, LineCoverage>();
  for (const record of content.split('\n')) {
    const [kind, value = ''] = record.split(/:(.*)/s);
    if (kind === 'SF') lines = linesOf(coverage, value.trim());
    if (kind === 'DA') {
      const [line, hits] = value.split(',').map(Number);
      if (line !== undefined && hits !== undefined) lines.set(line, { hits, partial: false });
    }
    if (kind === 'BRDA') {
      // BRDA:<line>,<block>,<branch>,<taken>, taken is "-" when the line itself never ran.
      const [line, , , taken] = value.split(',');
      const entry = lines.get(Number(line));
      if (entry && (taken === '-' || taken === '0')) entry.partial = true;
    }
  }
  return coverage;
}

function parseJacoco(content: string): Coverage {
  const coverage: Coverage = new Map();
  for (const pkg of content.matchAll(/<package name="([^"]+)">(.*?)<\/package>/gs)) {
    for (const source of (pkg[2] ?? '').matchAll(/<sourcefile name="([^"]+)">(.*?)<\/sourcefile>/gs)) {
      // JaCoCo names a file by package and file name only, so this assumes every source file sits
      // in the directory of its package, the convention in Java and Kotlin alike. A file that does
      // not shows up below as "not in the report".
      const lines = linesOf(coverage, backendSourcePath(`${pkg[1]}/${source[1]}`));
      for (const line of (source[2] ?? '').matchAll(/<line nr="(\d+)" mi="(\d+)" ci="(\d+)" mb="(\d+)" cb="(\d+)"\/>/g)) {
        // mi/ci: missed/covered instructions, mb: missed branches.
        const [, nr = 0, , ci = 0, mb = 0] = line.map(Number);
        lines.set(nr, { hits: ci, partial: ci > 0 && mb > 0 });
      }
    }
  }
  return coverage;
}

function loadReport(
  side: Report['side'],
  file: string,
  covers: Report['covers'],
  parse: (content: string) => Coverage,
): Report | null {
  if (!existsSync(file)) return null;
  return { side, file, covers, coverage: parse(readFileSync(file, 'utf8')), modifiedAt: statSync(file).mtime };
}

/** quotePath off, so a non-ASCII path comes out as itself rather than as octal escapes. */
function git(...args: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** NUL-separated output, which no file name can break. */
function paths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

/**
 * Repo-relative path → the line numbers it has now that the base did not, for the files a report
 * covers. One diff per file, so the path is always the one asked for and only the hunk headers
 * need parsing; a file header would be ambiguous with an added line that starts with "++ ".
 */
function changedLines(base: string, relevant: (path: string) => boolean): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  for (const path of paths(git('diff', '--name-only', '-z', '--diff-filter=d', '--merge-base', base))) {
    if (!relevant(path)) continue;
    const lines = new Set<number>();
    for (const header of git('diff', '-U0', '--no-color', '--no-ext-diff', '--merge-base', base, '--', path).matchAll(
      /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm,
    )) {
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      for (let line = start; line < start + count; line++) lines.add(line);
    }
    changed.set(path, lines);
  }
  for (const path of paths(git('ls-files', '--others', '--exclude-standard', '-z'))) {
    if (!relevant(path)) continue;
    const count = readFileSync(`${REPO_ROOT}${path}`, 'utf8').replace(/\n$/, '').split('\n').length;
    changed.set(path, new Set(Array.from({ length: count }, (_, i) => i + 1)));
  }
  return changed;
}

/**
 * "42-48, 71". Two gaps merge when no other executable line stands between them, so a comment or
 * a blank line inside an uncovered block does not split it in two.
 */
function asRanges(lineNumbers: number[], lines: Map<number, LineCoverage>): string {
  const executable = [...lines.keys()].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const line of lineNumbers) {
    const last = ranges.at(-1);
    if (last && !executable.some((other) => other > last[1] && other < line)) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(', ');
}

function main(): number {
  const { values } = parseArgs({ options: { base: { type: 'string', default: DEFAULT_BASE_REF } } });
  const base = values.base;

  const reports = [
    loadReport('frontend', FRONTEND_LCOV, isFrontendSource, parseLcov),
    loadReport('backend', BACKEND_JACOCO_XML, isBackendSource, parseJacoco),
  ].filter((report): report is Report => report !== null);
  if (reports.length === 0) {
    console.log('No coverage report found. Run `npm run test:coverage` in e2e/ first.');
    return 1;
  }

  let changed: Map<string, Set<number>>;
  try {
    changed = changedLines(base, (path) => reports.some((report) => report.covers(path)));
  } catch (failure) {
    if (/no merge base/.test(String(failure))) {
      console.log(`This branch shares no history with ${base}: name a ref it does share with --base <ref>.`);
    }
    console.log(`Cannot diff against ${base}: ${String(failure)}`);
    return 1;
  }

  console.log(`Coverage gaps in lines changed since ${base}, from the last e2e coverage run:`);
  for (const report of reports) console.log(`  ${report.side}: ${report.file} (${report.modifiedAt.toLocaleString()})`);
  if (!reports.some((report) => report.side === 'backend')) {
    console.log('  backend: no report, the last run had no JaCoCo agent (e2e/backend-coverage.ts)');
  }
  if (existsSync(BACKEND_MISMATCH_FILE)) {
    const count = readFileSync(BACKEND_MISMATCH_FILE, 'utf8').split('\n').filter(Boolean).length;
    console.log(
      `  WARNING: ${count} backend classes were recompiled while the backend ran and read as uncovered here. ` +
        `Restart the backend (${BACKEND_START_COMMAND}) and re-run before trusting backend gaps.`,
    );
  }
  console.log('');

  let executableTotal = 0;
  let uncoveredTotal = 0;
  const missing: string[] = [];
  const stale: string[] = [];

  for (const [path, changedInFile] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
    const report = reports.find((r) => r.covers(path));
    if (!report) continue;
    if (statSync(`${REPO_ROOT}${path}`).mtime > report.modifiedAt) stale.push(path);

    const lines = report.coverage.get(path);
    if (!lines) {
      missing.push(path);
      continue;
    }
    const executable = [...changedInFile].filter((line) => lines.has(line)).sort((a, b) => a - b);
    const uncovered = executable.filter((line) => lines.get(line)?.hits === 0);
    const partial = executable.filter((line) => lines.get(line)?.partial && !uncovered.includes(line));
    executableTotal += executable.length;
    uncoveredTotal += uncovered.length;
    if (uncovered.length === 0 && partial.length === 0) continue;

    const parts = [];
    if (uncovered.length > 0) parts.push(`uncovered ${asRanges(uncovered, lines)}`);
    if (partial.length > 0) parts.push(`branch never taken ${partial.join(', ')}`);
    console.log(`${path}: ${parts.join('; ')} (${uncovered.length}/${executable.length} changed lines uncovered)`);
  }

  if (missing.length > 0) {
    console.log(`\nChanged, but not in the report: created after the run, or without executable code (an interface):`);
    for (const path of missing) console.log(`  ${path}`);
  }
  if (stale.length > 0) {
    console.log(`\nThe report predates the last edit of ${stale.length} of these files; re-run \`npm run test:coverage\`.`);
  }

  const percent = executableTotal === 0 ? 100 : Math.round((100 * (executableTotal - uncoveredTotal)) / executableTotal);
  console.log(
    `\n${uncoveredTotal} of ${executableTotal} changed executable lines are not run by any e2e test (${percent} % covered).`,
  );
  return 0;
}

process.exitCode = main();
