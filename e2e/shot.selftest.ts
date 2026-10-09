#!/usr/bin/env node
/**
 * Self-test of the shot.ts sensors against static fixtures, without the app.
 *
 * A sensor is only worth its report line if it provably fires on a broken page and provably stays
 * quiet on a clean one; the second half matters more, because a sensor that cries wolf gets
 * ignored. clean.html is therefore the one fixture that must never be made "worse" to get this
 * green — a false positive there is fixed in the sensor.
 *
 *   npm run shot:selftest
 *
 * Serves shot-fixtures/ from a throwaway node:http server, runs shot.ts against it with
 * SHOT_CONFIG pointing at the fixtures' own configs, and writes every shot into a temporary
 * directory that is removed at the end.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { LABEL_WIDTH, LINE_MAX, SENSOR_NAMES } from './shot-sensors.ts';

const E2E_DIR = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(E2E_DIR, 'shot-fixtures');
const CONCURRENCY = 4;
/** Where a report value starts: the padded label plus one space. */
const VALUE_AT = LABEL_WIDTH + 1;

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };

/** `?delay=<ms>` holds a response back — how cls.html gets an image that arrives late. */
const serveFixtures = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/favicon.ico') return res.writeHead(204).end();
  const file = normalize(join(FIXTURES, url.pathname));
  if (!file.startsWith(FIXTURES)) return res.writeHead(403).end();
  const delay = Number(url.searchParams.get('delay') ?? 0);
  if (delay) await new Promise(done => setTimeout(done, delay));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
};
const server = createServer(serveFixtures);
// The same fixtures from a second port: what `--port` serves from, while the origin stays on the first.
const second = createServer(serveFixtures);
await Promise.all([server, second].map(s => new Promise<void>(done => s.listen(0, '127.0.0.1', done))));
const BASE_URL = `http://localhost:${(server.address() as AddressInfo).port}`;
const SECOND_PORT = (second.address() as AddressInfo).port;
const OUT_DIR = await mkdtemp(join(tmpdir(), 'shot-selftest-'));

interface Shot {
  stdout: string;
  stderr: string;
  code: number;
}

function shot(route: string, args: string[] = [], config = 'shot.config.ts'): Promise<Shot> {
  return new Promise(done => {
    execFile(
      process.execPath,
      ['shot.ts', route, '--anon', ...args],
      {
        cwd: E2E_DIR,
        env: { ...process.env, BASE_URL, SHOT_CONFIG: `shot-fixtures/${config}`, SHOT_OUT_DIR: OUT_DIR },
      },
      (err, stdout, stderr) => done({ stdout, stderr, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 }),
    );
  });
}

/** A sensor's head line and its detail lines, or null when the sensor did not report at all. */
function section(out: string, label: string): { head: string; details: string[] } | null {
  const lines = out.split('\n');
  const at = lines.findIndex(line => line.startsWith(`${label.padEnd(LABEL_WIDTH)} `));
  if (at === -1) return null;
  const details: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith(' '.repeat(VALUE_AT))) break;
    details.push(line.trim());
  }
  return { head: lines[at]!.slice(VALUE_AT), details };
}

/** Collects failed expectations instead of stopping at the first, so one run shows them all. */
class Check {
  failures: string[] = [];
  readonly out: Shot;

  constructor(out: Shot) {
    this.out = out;
  }

  head(label: string, expected: RegExp): this {
    const s = section(this.out.stdout, label);
    if (!s) this.failures.push(`${label}: no line`);
    else if (!expected.test(s.head)) this.failures.push(`${label}: "${s.head}" does not match ${expected}`);
    return this;
  }

  absent(label: string): this {
    if (section(this.out.stdout, label)) this.failures.push(`${label}: reported, expected no line`);
    return this;
  }

  detail(label: string, expected: RegExp | string): this {
    const details = section(this.out.stdout, label)?.details ?? [];
    const hit = details.some(d => (typeof expected === 'string' ? d.includes(expected) : expected.test(d)));
    if (!hit) this.failures.push(`${label}: no detail matching ${expected}`);
    return this;
  }

  noDetail(label: string, unexpected: RegExp | string): this {
    const details = section(this.out.stdout, label)?.details ?? [];
    const hit = details.find(d => (typeof unexpected === 'string' ? d.includes(unexpected) : unexpected.test(d)));
    if (hit) this.failures.push(`${label}: unexpected detail "${hit}"`);
    return this;
  }

  detailCount(label: string, count: number): this {
    const n = section(this.out.stdout, label)?.details.length ?? 0;
    if (n !== count) this.failures.push(`${label}: ${n} detail line(s), expected ${count}`);
    return this;
  }

  exit(code: 0 | 'non-zero'): this {
    const ok = code === 0 ? this.out.code === 0 : this.out.code !== 0;
    if (!ok) this.failures.push(`exit code ${this.out.code}, expected ${code}`);
    return this;
  }

  /** Every line within the token budget, the harness's own lines included. */
  budget(): this {
    for (const line of this.out.stdout.split('\n')) {
      if (line.length > LINE_MAX) this.failures.push(`line over ${LINE_MAX} chars: ${line.slice(0, 60)}…`);
    }
    return this;
  }
}

interface Case {
  name: string;
  run: () => Promise<Check[]>;
}

const CASES: Case[] = [
  {
    name: 'clean.html — every sensor quiet',
    run: async () => [
      new Check(await shot('/clean.html', ['--out=clean', '--reset-diff']))
        .exit(0)
        .budget()
        .head('console', /^clean$/)
        .head('network', /^clean$/)
        .head('a11y', /^clean; 0 incomplete/)
        .head('diff', /^baseline created$/)
        .head('cls', /^none$/)
        .head('text', /^clean$/)
        .head('html', /^clean \(dom\)/),
    ],
  },
  {
    name: 'a11y.html — image-alt, color-contrast, button-name',
    run: async () => [
      new Check(await shot('/a11y.html', ['--checks=a11y', '--detail=a11y']))
        .exit(0)
        .budget()
        .head('a11y', /^\d+ rule\(s\), \d+ node\(s\)/)
        .detail('a11y', / image-alt ×/)
        .detail('a11y', / color-contrast ×/)
        .detail('a11y', / button-name ×/),
    ],
  },
  {
    // The inserted banner itself never shifts — it is new. What shifts is what it pushes down, and
    // Chromium names the outermost element that moved as a whole: <main>, not the section inside it.
    name: 'cls.html — a late banner and an unsized image shift the page',
    run: async () => [
      new Check(await shot('/cls.html', ['--checks=cls', '--detail=cls']))
        .exit(0)
        .budget()
        .head('cls', /^(0\.[1-9]\d|0\.0[1-9]|[1-9]\d*\.\d\d) \(sum\), \d+ shift\(s\)$/)
        .detail('cls', /^main {2}≈\d\.\d\d in 1 shift\(s\), moved 0→\d+px$/)
        .detail('cls', /^p\.below {2}≈/),
    ],
  },
  {
    // The browser reports an element outside the viewport with an empty rect at y 0 — read naively,
    // a footer pushed below the fold "moved to the top".
    name: 'cls-offscreen.html — a footer pushed out of view, named by its own class',
    run: async () => [
      new Check(await shot('/cls-offscreen.html', ['--checks=cls', '--detail=cls']))
        .exit(0)
        .budget()
        .detail('cls', /^div\.app-footer {2}≈\d\.\d\d in 1 shift\(s\), pushed out of view from \d+px$/)
        .noDetail('cls', 'mat-toolbar'),
    ],
  },
  {
    name: 'text.html — leaks reported, ordinary copy left alone',
    run: async () => {
      const detail = new Check(await shot('/text.html', ['--checks=text', '--detail=text']))
        .exit(0)
        .budget()
        .head('text', /^\d+ finding\(s\)$/)
        .detail('text', 'pattern "undefined" in p.greeting: "Hello undefined, welcome back"')
        .detail('text', 'pattern "NaN" in p.price')
        .detail('text', 'pattern "[object Object]" in p.object')
        .detail('text', 'pattern "{{" in p.template')
        .detail('text', 'i18n key "pricing.plan.title" in h3.plan-name')
        .detail('text', 'i18n key "nav.main.open" in nav[aria-label]')
        .detail('text', /^truncated \(ellipsis\) span\.product-name: "Ergonomic office chair/)
        .detail('text', 'pattern "[object Object]" in input.category[value]')
        .detail('text', 'pattern "undefined" in textarea.note[value]')
        .noDetail('text', 'input.secret')
        .noDetail('text', 'neg-')
        .noDetail('text', 'null')
        .noDetail('text', 'example')
        .noDetail('text', '1.2.3');
      // The short report keeps to its budget however much it found.
      const short = new Check(await shot('/text.html', ['--checks=text', '--out=text-short'])).detailCount('text', 3);
      return [detail, short];
    },
  },
  {
    name: 'html.html — duplicate id, button in a link, invalid attribute value',
    run: async () => [
      new Check(await shot('/html.html', ['--checks=html', '--detail=html']))
        .exit(0)
        .budget()
        .head('html', /^\d+ error\(s\).* \(dom\)/)
        .detail('html', /^\[dom\] no-dup-id {2}.*Duplicate ID "email"/)
        .detail('html', /^\[dom\] element-permitted-content {2}.*a(\.card)? > button/)
        .detail('html', /^\[dom\] attribute-allowed-values {2}.*"nonsense"/),
    ],
  },
  {
    name: 'raw.html — a parse error only the raw response still has',
    run: async () => [
      new Check(await shot('/raw.html', ['--checks=html', '--detail=html'], 'shot.config.raw.ts'))
        .exit(0)
        .budget()
        .head('html', /^clean \(dom\), \d+ error\(s\) \(raw\)/)
        .detail('html', /^\[raw\] /)
        .noDetail('html', /^\[dom/),
    ],
  },
  {
    name: 'diff.html — baseline, unchanged, changed',
    run: async () => {
      const first = new Check(await shot('/diff.html?v=1', ['--out=diff', '--reset-diff', '--checks=diff']))
        .exit(0)
        .head('diff', /^baseline created$/);
      const same = new Check(await shot('/diff.html?v=1', ['--out=diff', '--checks=diff'])).head('diff', /^none vs last run$/);
      const changed = new Check(await shot('/diff.html?v=2', ['--out=diff', '--checks=diff']))
        .budget()
        .head('diff', /^\d+ px \((<0\.01|\d+(\.\d+)?)%\) vs last run; .*diff\.diff\.png$/)
        .detail('diff', /section\.target/);
      // One digit of 14px text, well under any share of a 1280x800 shot.
      const digit = new Check(await shot('/diff.html?v=2&price=130', ['--out=diff', '--checks=diff']))
        .head('diff', /^\d\d+ px \(<?0\.\d+%\) vs last run; /)
        .detail('diff', /p\.price/);
      return [first, same, changed, digit];
    },
  },
  {
    name: 'diff.html --full — a change below the fold, then a change in height',
    run: async () => {
      const args = ['--out=diff-full', '--full', '--checks=diff'];
      await shot('/diff.html?v=1&tall', [...args, '--reset-diff']);
      const below = new Check(await shot('/diff.html?v=2&tall', args))
        .head('diff', /%\) vs last run; /)
        .detail('diff', /^y (1[6-9]|2\d)\d\d–\d+ .*section\.target/);
      const shorter = new Check(await shot('/diff.html?v=2', args)).head('diff', /; height \d+ → \d+px/);
      return [below, shorter];
    },
  },
  {
    name: 'diff --port — a baseline per serving port',
    run: async () => {
      const args = ['--out=diff-port', '--checks=diff'];
      await shot('/diff.html?v=1', [...args, '--reset-diff']);
      const other = new Check(await shot('/diff.html?v=1', [...args, `--port=${SECOND_PORT}`]))
        .exit(0)
        .head('served', new RegExp(`^:${SECOND_PORT} `))
        .head('diff', /^baseline created$/);
      const again = new Check(await shot('/diff.html?v=1', [...args, `--port=${SECOND_PORT}`])).head('diff', /^none vs last run$/);
      return [other, again];
    },
  },
  {
    name: '--checks=a11y — only the a11y line',
    run: async () => [
      new Check(await shot('/clean.html', ['--checks=a11y', '--out=only-a11y']))
        .head('a11y', /^clean/)
        .absent('diff')
        .absent('cls')
        .absent('text')
        .absent('html'),
    ],
  },
  {
    name: '--skip=html — everything but html',
    run: async () => [
      new Check(await shot('/clean.html', ['--skip=html', '--out=skip-html']))
        .head('a11y', /^clean/)
        .head('diff', /./)
        .head('cls', /^none$/)
        .head('text', /^clean$/)
        .absent('html'),
    ],
  },
  {
    name: 'config false beats --checks',
    run: async () => [
      new Check(await shot('/clean.html', ['--checks=cls,text', '--out=disabled'], 'shot.config.disabled.ts'))
        .head('cls', /^disabled in shot\.config\.ts$/)
        .head('text', /^clean$/),
    ],
  },
  {
    name: 'a sensor error stays in its line',
    run: async () => [
      new Check(await shot('/clean.html', ['--scope=#nothing-here', '--out=scope-error']))
        .exit(0)
        .head('a11y', /^error: --scope "#nothing-here" matches nothing/)
        .head('cls', /^none$/)
        .head('html', /^clean \(dom\)/),
    ],
  },
  {
    name: 'an unknown sensor name is refused',
    run: async () => {
      const check = new Check(await shot('/clean.html', ['--checks=a11y,colour'])).exit('non-zero');
      if (!check.out.stderr.includes(SENSOR_NAMES.join('|'))) check.failures.push('stderr does not list the valid names');
      return [check];
    },
  },
];

async function runCase(c: Case): Promise<{ name: string; failures: string[]; output: string }> {
  try {
    const checks = await c.run();
    return {
      name: c.name,
      failures: checks.flatMap(check => check.failures),
      output: checks.map(check => check.out.stdout + check.out.stderr).join('\n---\n'),
    };
  } catch (err) {
    return { name: c.name, failures: [`threw: ${err instanceof Error ? err.message : String(err)}`], output: '' };
  }
}

const results: Awaited<ReturnType<typeof runCase>>[] = [];
try {
  const queue = [...CASES];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) results.push(await runCase(c));
    }),
  );
} finally {
  server.close();
  second.close();
  await rm(OUT_DIR, { recursive: true, force: true });
}

const ordered = CASES.map(c => results.find(r => r.name === c.name)!);
for (const r of ordered) {
  console.log(`${r.failures.length ? '✗' : '✓'} ${r.name}`);
  for (const failure of r.failures) console.log(`    ${failure}`);
  if (r.failures.length) console.log(r.output.replace(/^/gm, '    | '));
}
const failed = ordered.filter(r => r.failures.length).length;
console.log(`\n${ordered.length - failed}/${ordered.length} passed`);
process.exit(failed ? 1 : 0);
