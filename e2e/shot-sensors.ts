/**
 * The sensors of the screenshot harness: five deterministic checks that turn what a PNG would only
 * hint at into report lines. See the header of shot.ts for the flags, shot.config.ts for the knobs.
 *
 *   a11y   WCAG violations and axe best practices in the rendered DOM (axe-core)
 *   diff   what changed visibly since the last run of the same shot, traced back to DOM elements
 *   cls    which elements jumped while the page loaded — invisible in a shot taken afterwards
 *   text   undefined, NaN, [object Object], template leftovers, raw i18n keys, clipped text
 *   html   invalid HTML in the DOM (html-validate), optionally in the raw document response too
 *
 * Sensors are sensors, not gates: a finding never changes the exit code, and a sensor that throws
 * reports `<label> error: …` while every other sensor carries on. A broken check must not cost the
 * agent the shot it asked for.
 */

import { AxeBuilder } from '@axe-core/playwright';
import { UI_FRAMEWORK_CLASS_PATTERN } from './project.ts';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { HtmlValidate, type RuleConfig } from 'html-validate';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page, Response } from 'playwright';

/** One entry per sensor; the config shape, the factories and the names all derive from it. */
interface SensorConfigs {
  a11y: A11yConfig;
  diff: DiffConfig;
  cls: ClsConfig;
  text: TextConfig;
  html: HtmlConfig;
}
type SensorName = keyof SensorConfigs;

/** The report order, which is also the order the flags list them in. */
export const SENSOR_NAMES = ['a11y', 'diff', 'cls', 'text', 'html'] as const satisfies readonly SensorName[];

/**
 * shot.config.ts: the human's half of the sensor settings. The CLI flags are the agent's half, and
 * they can only narrow what this file allows — a sensor switched off here stays off whatever
 * `--checks` asks for. A missing entry runs the sensor with its defaults.
 *
 * ```ts
 * const config: ShotConfig = {
 *   checks: {
 *     a11y: { exclude: ['iframe.youtube'] },
 *     diff: { mask: ['.clock', 'app-avatar'], freezeTime: '2026-09-01T10:00:00+02:00' },
 *     html: false,
 *   },
 * };
 * ```
 */
export interface ShotConfig {
  checks?: { [K in SensorName]?: SensorConfigs[K] | false };
}

export interface A11yConfig {
  /** axe tags to run. Default: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] */
  tags?: string[];
  /** Rule ids to skip entirely, e.g. ['region'] while a page has no landmarks by design. */
  disableRules?: string[];
  /** CSS selectors axe never looks into, e.g. ['iframe.youtube'] for an embedded third-party widget. */
  exclude?: string[];
}

export interface DiffConfig {
  /** pixelmatch colour threshold 0..1, smaller is more sensitive. Default 0.1 */
  threshold?: number;
  /**
   * Fewer changed pixels than this count as unchanged. Default 1, i.e. any: two runs of an unchanged
   * route differ by 0 px (nine routes, 2026-09-28), and the head line carries the count, so a stray
   * handful reads as what it is. A count rather than a share of the image, because a changed digit in
   * 14px text is some 50 pixels, which a share of a large or --full shot swallows.
   */
  minPixels?: number;
  /**
   * CSS selectors of areas that change on every run (a clock, a carousel, an avatar), painted over
   * in the screenshot. The mask lands in the PNG the agent looks at as well — a flat colour block.
   * That is deliberate: a second screenshot only for the diff would double the run time.
   */
  mask?: string[];
  /**
   * Pins `Date.now()` and `new Date()` of the route to this ISO timestamp, e.g.
   * '2026-09-01T10:00:00+02:00'. Timers keep running, so the page still settles. Default: off.
   * Set only after the login, because a frozen clock can break token lifetimes; a date far from
   * today can still make an OIDC client library consider a restored token expired on the route itself.
   */
  freezeTime?: string;
}

export interface ClsConfig {
  /** Below this sum of layout-shift values the sensor reports 'none'. Default 0.01 */
  minTotal?: number;
}

export interface TextConfig {
  /** Extra suspicious patterns as RegExp sources, e.g. ['\\bnull\\b'] (deliberately not a default). */
  patterns?: string[];
  /**
   * Findings to drop. An entry drops a finding when it equals the matched text exactly, or when it
   * is a RegExp source matching the finding's report line — so whatever the report shows can be
   * silenced: 'i18n key "z.b.x"', 'truncated \\(clip\\) mat-icon'.
   */
  ignore?: string[];
  /** Detect raw i18n keys such as pricing.plan.title. Default true */
  i18nKeys?: boolean;
}

export interface HtmlConfig {
  /** html-validate preset. Default 'html-validate:standard' — not the a11y preset, axe covers that. */
  preset?: string;
  /** Rule overrides, e.g. { 'no-inline-style': 'off' } against framework noise. */
  rules?: Record<string, unknown>;
  /** Validate the raw document response as well (for SSR/SSG output). Default false */
  raw?: boolean;
}

/** The agent's half: what the CLI asked for. */
export interface SensorFlags {
  /** `--checks=…`: only these; null runs every sensor the config allows. */
  checks: SensorName[] | null;
  /** `--skip=…` */
  skip: SensorName[];
  /** `--detail=…`; a bare `--detail` means all of them. */
  detail: SensorName[];
  /** `--scope=<css selector>`: limits a11y and text to a subtree. */
  scope: string | null;
  /** `--reset-diff`: drop this shot's baseline before comparing. */
  resetDiff: boolean;
}

export function parseSensorFlags(flags: Record<string, string | true>): SensorFlags {
  return {
    checks: flags.checks === undefined ? null : sensorList('checks', flags.checks),
    skip: flags.skip === undefined ? [] : sensorList('skip', flags.skip),
    detail:
      flags.detail === undefined ? [] : flags.detail === true ? [...SENSOR_NAMES] : sensorList('detail', flags.detail),
    scope: requireValue('scope', flags.scope),
    resetDiff: flags['reset-diff'] === true,
  };
}

function sensorList(flag: string, value: string | true): SensorName[] {
  const names = requireValue(flag, value)!.split(',').map(name => name.trim()).filter(Boolean);
  for (const name of names) {
    if (!(SENSOR_NAMES as readonly string[]).includes(name)) {
      throw new Error(`--${flag}: unknown sensor "${name}", must be one of ${SENSOR_NAMES.join('|')}`);
    }
  }
  return names as SensorName[];
}

function requireValue(flag: string, value: string | true | undefined): string | null {
  if (value === undefined) return null;
  if (value === true || value === '') throw new Error(`--${flag} needs a value: --${flag}=…`);
  return value;
}

/** What a sensor needs to know about the shot it is looking at. */
export interface SensorRun {
  page: Page;
  outDir: string;
  /** `--out` or the slugified route: the stem of every file this shot writes. */
  name: string;
  /** 'anon' or the login's cache key. Different logins see different pages, so they never share a baseline. */
  session: string;
  /**
   * The server the page's bytes come from, as a file-name slug (`localhost-4201` under `--port`). Part
   * of the baseline key: a worktree's frontend compared with main's would answer "what differs from
   * main" under the heading of "what did my last edit change".
   */
  served: string;
  viewport: { width: number; height: number };
  full: boolean;
  scope: string | null;
  resetDiff: boolean;
  /** Where the screenshot lands; the diff reads it back from there. */
  shotPath: string;
  /** Set by shot.ts once the page has landed: the `assumes` line did not hold. */
  wrongPage: boolean;
  /** Renders a path the way the `shot` line does. */
  display: (path: string) => string;
}

interface SensorReport {
  head: string;
  details: string[];
  /** A report that is about the run rather than the page — no `(wrong page)` suffix. */
  aboutRun?: boolean;
}

/**
 * One sensor, as hooks into the fixed sequence of shot.ts. The sequence matters: text and html read
 * the page before the screenshot, cls reads its shifts before axe and the diff mapping scroll and
 * cause new ones, and the diff baseline is only replaced once the report is out.
 */
interface Sensor {
  beforeNavigation?(): Promise<void>;
  beforeScreenshot?(response: Response | null): Promise<void>;
  mask?(): Locator[];
  afterScreenshot?(): Promise<void>;
  afterReport?(): Promise<void>;
  report(detail: boolean): SensorReport;
}

interface Slot {
  name: SensorName;
  sensor: Sensor;
  detail: boolean;
  ms: number;
  error: string | null;
}

/** The width shot.ts pads report labels to; lines stay within LINE_MAX including that prefix. */
export const LABEL_WIDTH = 10;
export const LINE_MAX = 160;
const SHORT_DETAILS = 3;
const LONG_DETAILS = 20;
/**
 * The order the hooks run in, as opposed to the report order: cls reads its shifts first, because axe
 * and the diff mapping scroll the page and every shift they cause would be counted as the route's.
 */
const RUN_ORDER: SensorName[] = ['cls', 'text', 'html', 'a11y', 'diff'];
/** Sensors slower than this get their duration printed; a11y and html always do. */
const SLOW_MS = 300;
const ALWAYS_TIMED: SensorName[] = ['a11y', 'html'];

export function createSensors(config: ShotConfig, flags: SensorFlags, run: SensorRun) {
  const slots: Slot[] = [];
  const disabled: SensorName[] = [];

  for (const name of RUN_ORDER) {
    if (flags.checks && !flags.checks.includes(name)) continue;
    if (flags.skip.includes(name)) continue;
    const entry = config.checks?.[name];
    if (entry === false) {
      // Only worth a line when the agent asked for it by name; otherwise the config spoke and that is that.
      if (flags.checks?.includes(name)) disabled.push(name);
      continue;
    }
    slots.push({ name, sensor: SENSOR_FACTORIES[name](entry ?? {}, run), detail: flags.detail.includes(name), ms: 0, error: null });
  }

  async function phase(hook: (sensor: Sensor) => Promise<void> | undefined): Promise<void> {
    for (const slot of slots) {
      if (slot.error) continue;
      const started = performance.now();
      try {
        await hook(slot.sensor);
      } catch (err) {
        slot.error = err instanceof Error ? err.message : String(err);
      } finally {
        slot.ms += performance.now() - started;
      }
    }
  }

  return {
    beforeNavigation: () => phase(sensor => sensor.beforeNavigation?.()),
    beforeScreenshot: (response: Response | null) => phase(sensor => sensor.beforeScreenshot?.(response)),
    mask: (): Locator[] => slots.filter(slot => !slot.error).flatMap(slot => slot.sensor.mask?.() ?? []),
    afterScreenshot: () => phase(sensor => sensor.afterScreenshot?.()),
    afterReport: () => phase(sensor => sensor.afterReport?.()),

    lines(): [string, string][] {
      const lines: [string, string][] = [];
      for (const name of SENSOR_NAMES) {
        if (disabled.includes(name)) lines.push([name, 'disabled in shot.config.ts']);
        // Report order, not RUN_ORDER.
        const slot = slots.find(s => s.name === name);
        if (slot) lines.push(...slotLines(slot, run.wrongPage));
      }
      return lines;
    },
  };
}

function slotLines(slot: Slot, wrongPage: boolean): [string, string][] {
  let report: SensorReport;
  if (slot.error) {
    report = { head: `error: ${slot.error.split('\n')[0]}`, details: [], aboutRun: true };
  } else {
    try {
      report = slot.sensor.report(slot.detail);
    } catch (err) {
      report = { head: `error: ${err instanceof Error ? err.message : String(err)}`, details: [], aboutRun: true };
    }
  }

  const ms = Math.round(slot.ms);
  let suffix = '';
  if (!slot.error && (ALWAYS_TIMED.includes(slot.name) || ms > SLOW_MS)) suffix += ` (${ms}ms)`;
  if (wrongPage && !report.aboutRun) suffix += ' (wrong page)';

  const details = report.details.slice(0, slot.detail ? LONG_DETAILS : SHORT_DETAILS);
  return [
    // The suffix survives clipping: `(wrong page)` is the one part of a long head that must not go.
    [slot.name, clip(report.head, LINE_MAX - LABEL_WIDTH - 1 - suffix.length) + suffix],
    ...details.map((d): [string, string] => ['', `  ${clip(d, LINE_MAX - LABEL_WIDTH - 3)}`]),
  ];
}

/** Line breaks go, runs of spaces stay: the report separates fields with two of them. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s*[\r\n\t]\s*/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const SENSOR_FACTORIES: { [K in SensorName]: (config: SensorConfigs[K], run: SensorRun) => Sensor } = { a11y: a11ySensor, diff: diffSensor, cls: clsSensor, text: textSensor, html: htmlSensor };

/**
 * How every sensor names an element; runs in the browser. The app's own class wins over the UI
 * framework's (UI_FRAMEWORK_CLASS_PATTERN in project.ts): those name the component, not the
 * instance — header and footer are both `mat-toolbar.mat-toolbar`, only the footer is `app-footer`
 * as well. With no class of its own, a component goes by its tag.
 */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const classes = [...el.classList];
  const own = classes.find(c => !UI_FRAMEWORK_CLASS_PATTERN.test(c));
  if (own) return `${tag}.${own}`;
  return tag.includes('-') || !classes[0] ? tag : `${tag}.${classes[0]}`;
}

/**
 * describeElement as source for the browser, with the pattern inlined: page.evaluate serialises a
 * function alone, nothing it closes over comes along, and the pattern is a module constant.
 */
const DESCRIBE_ELEMENT_SOURCE = describeElement
  .toString()
  .replace(/UI_FRAMEWORK_CLASS_PATTERN/g, UI_FRAMEWORK_CLASS_PATTERN.toString());

/** page.evaluate for the browser-side functions that name elements; describeElement travels along as source. */
function inPage<A, R>(page: Page, fn: (arg: A, describe: typeof describeElement) => R, arg: A): Promise<R> {
  return page.evaluate<R>(`(${fn.toString()})(${JSON.stringify(arg)}, ${DESCRIBE_ELEMENT_SOURCE})`);
}

/** A scope that matches nothing would otherwise read as a clean page. */
async function assertScope(run: SensorRun): Promise<void> {
  if (run.scope && (await run.page.locator(run.scope).count()) === 0) {
    throw new Error(`--scope "${run.scope}" matches nothing on the page`);
  }
}

// ── a11y ────────────────────────────────────────────────────────────────────────────────────────

// best-practice adds rules no WCAG criterion demands, such as landmark-unique and heading-order.
// Measured on eight routes, it cost no runtime and added one finding, so it earns its place.
const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];
const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeResult = AxeResults['violations'][number];

function a11ySensor(config: A11yConfig, run: SensorRun): Sensor {
  let results: AxeResults | null = null;

  return {
    async afterScreenshot() {
      await assertScope(run);
      let builder = new AxeBuilder({ page: run.page }).withTags(config.tags ?? A11Y_TAGS);
      if (config.disableRules?.length) builder = builder.disableRules(config.disableRules);
      for (const selector of config.exclude ?? []) builder = builder.exclude(selector);
      if (run.scope) builder = builder.include(run.scope);
      results = await builder.analyze();
    },

    report(detail) {
      if (!results) throw new Error('axe did not run');
      const violations = [...results.violations].sort(
        (a, b) => impactRank(a) - impactRank(b) || b.nodes.length - a.nodes.length,
      );
      const nodes = violations.reduce((sum, v) => sum + v.nodes.length, 0);
      const incomplete = `${results.incomplete.length} incomplete`;
      const head = violations.length
        ? `${violations.length} rule(s), ${nodes} node(s); ${incomplete}`
        : `clean; ${incomplete}`;

      const details: string[] = [];
      for (const v of violations) {
        const targets = v.nodes.map(node => axeTarget(node.target));
        details.push(`${v.impact ?? 'unknown'} ${v.id} ×${v.nodes.length}  ${targets.slice(0, 2).join(', ')}`);
        if (detail) {
          for (const [i, node] of v.nodes.entries()) details.push(`  ${targets[i]}: ${firstSummaryLine(node.failureSummary)}`);
        }
      }
      if (detail) {
        for (const r of results.incomplete) details.push(`incomplete: ${r.id} ×${r.nodes.length}`);
      }
      return { head, details };
    },
  };
}

function impactRank(result: AxeResult): number {
  const rank = IMPACT_ORDER.indexOf(result.impact ?? '');
  return rank === -1 ? IMPACT_ORDER.length : rank;
}

/** A target is a list of selectors, one per shadow root or frame on the way down. */
function axeTarget(target: unknown[]): string {
  return target.flat(Infinity).join(' >> ');
}

/** failureSummary opens with "Fix any/all of the following:"; the first line after it is the finding. */
function firstSummaryLine(summary: string | undefined): string {
  const lines = (summary ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  return lines.find(line => !/^Fix (any|all) of the following:?$/i.test(line)) ?? lines[0] ?? '';
}

// ── diff ────────────────────────────────────────────────────────────────────────────────────────

const DIFF_COLOR: [number, number, number] = [255, 0, 0];
/** Changed rows closer than this belong to one band: one changed element, not five stripes. */
const BAND_GAP = 24;
const MAX_BANDS = 5;

interface Band {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
  pixels: number;
}

type DiffOutcome =
  | { kind: 'skipped' }
  | { kind: 'created' }
  | { kind: 'width'; from: number; to: number }
  | { kind: 'compared'; changed: number; percent: number; heights: [number, number]; diffPath: string | null; bands: (Band & { elements: string[] })[] };

/**
 * Compares the shot with the previous run of the same shot. The baseline lives in
 * `<outDir>/.baseline/` and is replaced after every run, so it answers "what did my last edit
 * change", not "what differs from main". Committed baselines would be wrong here anyway: CI renders
 * on Linux, the agents on macOS.
 */
function diffSensor(config: DiffConfig, run: SensorRun): Sensor {
  const baselineDir = join(run.outDir, '.baseline');
  const viewport = `${run.viewport.width}x${run.viewport.height}${run.full ? '-full' : ''}`;
  const baselinePath = join(baselineDir, `${run.name}-${viewport}-${run.session}-${run.served}.png`);
  const diffPath = join(run.outDir, `${run.name}.diff.png`);
  let outcome: DiffOutcome | null = null;
  let scroll = { x: 0, y: 0 };

  return {
    async beforeNavigation() {
      if (config.freezeTime) await run.page.clock.setFixedTime(config.freezeTime);
    },

    mask: () => (config.mask ?? []).map(selector => run.page.locator(selector)),

    async beforeScreenshot() {
      // An invalid mask selector would otherwise throw inside page.screenshot and take the shot down.
      for (const selector of config.mask ?? []) await run.page.locator(selector).count();
      // A viewport shot shows whatever the page had scrolled to; the mapping has to look there too.
      scroll = await run.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    },

    async afterScreenshot() {
      if (run.wrongPage) {
        outcome = { kind: 'skipped' };
        return;
      }
      if (run.resetDiff) await rm(baselinePath, { force: true });
      if (!existsSync(baselinePath)) {
        await rm(diffPath, { force: true });
        outcome = { kind: 'created' };
        return;
      }

      let previous: PNG;
      let current: PNG;
      try {
        previous = PNG.sync.read(await readFile(baselinePath));
        current = PNG.sync.read(await readFile(run.shotPath));
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : String(err)} (--reset-diff starts over)`, { cause: err });
      }
      if (previous.width !== current.width) {
        outcome = { kind: 'width', from: previous.width, to: current.width };
        return;
      }

      // Only --full shots can change height; the overlap is what both runs have in common.
      const width = current.width;
      const height = Math.min(previous.height, current.height);
      const bytes = width * height * 4;
      const out = new PNG({ width, height });
      const changed = pixelmatch(previous.data.subarray(0, bytes), current.data.subarray(0, bytes), out.data, width, height, {
        threshold: config.threshold ?? 0.1,
        includeAA: false,
        // Set explicitly: the band detection below looks for exactly this colour.
        diffColor: DIFF_COLOR,
        diffColorAlt: DIFF_COLOR,
      });

      const percent = (changed / (width * height)) * 100;
      const heights: [number, number] = [previous.height, current.height];
      if (changed < (config.minPixels ?? 1)) {
        await rm(diffPath, { force: true });
        outcome = { kind: 'compared', changed, percent, heights, diffPath: null, bands: [] };
        return;
      }

      await writeFile(diffPath, PNG.sync.write(out));
      const bands = findBands(out);
      const elements = await inPage(run.page, elementsAtBands, { bands, full: run.full, scroll });
      outcome = { kind: 'compared', changed, percent, heights, diffPath, bands: bands.map((band, i) => ({ ...band, elements: elements[i] ?? [] })) };
    },

    async afterReport() {
      // A wrong page would become the baseline the next right page is compared against.
      if (run.wrongPage || !existsSync(run.shotPath)) return;
      await mkdir(baselineDir, { recursive: true });
      await copyFile(run.shotPath, baselinePath);
    },

    report(detail) {
      if (!outcome) throw new Error('diff did not run');
      switch (outcome.kind) {
        case 'skipped':
          return { head: 'skipped — wrong page', details: [], aboutRun: true };
        case 'created':
          return { head: 'baseline created', details: [] };
        case 'width':
          return {
            head: `error: width mismatch ${outcome.from} → ${outcome.to}px; baseline replaced`,
            details: [],
            aboutRun: true,
          };
        case 'compared': {
          const [before, after] = outcome.heights;
          const height = before === after ? '' : `; height ${before} → ${after}px`;
          if (!outcome.diffPath) return { head: height ? `none in the overlap${height}` : 'none vs last run', details: [] };
          const percent =
            outcome.percent < 0.01 ? '<0.01' : outcome.percent < 1 ? outcome.percent.toFixed(2) : outcome.percent.toFixed(1);
          return {
            head: `${outcome.changed} px (${percent}%) vs last run${height}; ${run.display(outcome.diffPath)}`,
            details: outcome.bands
              .slice(0, detail ? MAX_BANDS : SHORT_DETAILS)
              .map(b => `y ${b.y0}–${b.y1} (x ${b.x0}–${b.x1})  ${b.elements.join(', ') || '(no element)'}`),
          };
        }
      }
    },
  };
}

/** Horizontal bands of changed rows, largest first. */
function findBands(diff: PNG): Band[] {
  const { width, height, data } = diff;
  const bands: Band[] = [];
  let open: Band | null = null;

  for (let y = 0; y < height; y++) {
    let x0 = -1;
    let x1 = -1;
    let pixels = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] === DIFF_COLOR[0] && data[i + 1] === DIFF_COLOR[1] && data[i + 2] === DIFF_COLOR[2]) {
        if (x0 === -1) x0 = x;
        x1 = x;
        pixels++;
      }
    }
    if (!pixels) continue;
    if (open && y - open.y1 < BAND_GAP) {
      open.y1 = y;
      open.x0 = Math.min(open.x0, x0);
      open.x1 = Math.max(open.x1, x1);
      open.pixels += pixels;
    } else {
      open = { y0: y, y1: y, x0, x1, pixels };
      bands.push(open);
    }
  }
  return bands.sort((a, b) => b.pixels - a.pixels).slice(0, MAX_BANDS);
}

/**
 * Runs in the browser, via inPage. Three probes across the middle row of each band; a --full shot is
 * in document coordinates, so the page scrolls there first.
 */
function elementsAtBands(
  arg: { bands: Band[]; full: boolean; scroll: { x: number; y: number } },
  describe: (el: Element) => string,
): string[][] {
  const isRoot = (el: Element | null) => !el || el === document.body || el === document.documentElement;

  if (!arg.full) window.scrollTo(arg.scroll.x, arg.scroll.y);
  return arg.bands.map(band => {
    const y = Math.round((band.y0 + band.y1) / 2);
    let viewY = y;
    if (arg.full) {
      window.scrollTo(0, Math.max(0, y - window.innerHeight / 2));
      viewY = y - window.scrollY;
    }
    const found = new Set<string>();
    for (const x of [band.x0, Math.round((band.x0 + band.x1) / 2), band.x1]) {
      const el = document
        .elementsFromPoint(Math.min(x, window.innerWidth - 1), viewY)
        .find(candidate => !isRoot(candidate));
      if (!el) continue;
      found.add(isRoot(el.parentElement) ? describe(el) : `${describe(el.parentElement!)} > ${describe(el)}`);
    }
    return [...found];
  });
}

// ── cls ─────────────────────────────────────────────────────────────────────────────────────────

/** `null` is outside the viewport: the browser reports an empty rect there, whose y of 0 would read as the top. */
interface ShiftRecord {
  value: number;
  sources: { el: string; from: number | null; to: number | null }[];
}

/**
 * Registered as an init script, so it runs before the app's own code on the route; describeElement
 * comes in as source, as with inPage. Sources are described when the shift happens: the element that
 * jumped is often gone by the time the shot is taken — a skeleton, a placeholder.
 */
function observeLayoutShifts(describeElement: (el: Element) => string): void {
  if (window !== window.top) return;

  interface LayoutShiftEntry extends PerformanceEntry {
    value: number;
    hadRecentInput: boolean;
    sources: { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
  }
  const describe = (node: Node | null): string => {
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    return el ? describeElement(el) : '(removed)';
  };
  const top = (rect: DOMRectReadOnly): number | null =>
    rect.width === 0 || rect.height === 0 ? null : Math.round(rect.y);

  const shifts: ShiftRecord[] = [];
  (window as unknown as { __shotShifts: ShiftRecord[] }).__shotShifts = shifts;
  new PerformanceObserver(list => {
    for (const entry of list.getEntries() as LayoutShiftEntry[]) {
      if (entry.hadRecentInput) continue;
      shifts.push({
        value: entry.value,
        sources: entry.sources.map(source => ({
          el: describe(source.node),
          from: top(source.previousRect),
          to: top(source.currentRect),
        })),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
}

/**
 * The plain sum of every shift, not the official CLS with its session windows: for a single page
 * load the sum says more, and calling it `(sum)` keeps it from being compared with a Lighthouse score.
 */
function clsSensor(config: ClsConfig, run: SensorRun): Sensor {
  let shifts: ShiftRecord[] | null = null;

  return {
    async beforeNavigation() {
      await run.page.addInitScript({ content: `(${observeLayoutShifts.toString()})(${DESCRIBE_ELEMENT_SOURCE})` });
    },

    async afterScreenshot() {
      shifts = await run.page.evaluate(
        () => (window as unknown as { __shotShifts?: ShiftRecord[] }).__shotShifts ?? null,
      );
      if (!shifts) throw new Error('the layout-shift observer never ran on this page');
    },

    report() {
      if (!shifts) throw new Error('cls did not run');
      const total = shifts.reduce((sum, shift) => sum + shift.value, 0);
      if (total < (config.minTotal ?? 0.01)) return { head: 'none', details: [] };

      // An entry's value cannot be split among its sources, so each source is credited the whole of
      // every shift it took part in. Hence ≈.
      // Per element the largest move is shown; entering or leaving the viewport counts as the largest.
      const distance = (m: { from: number | null; to: number | null }) =>
        m.from === null || m.to === null ? Infinity : Math.abs(m.to - m.from);
      const byElement = new Map<string, { value: number; shifts: number; from: number | null; to: number | null }>();
      for (const shift of shifts) {
        for (const source of new Map(shift.sources.map(s => [s.el, s])).values()) {
          const seen = byElement.get(source.el);
          if (!seen) {
            byElement.set(source.el, { value: shift.value, shifts: 1, from: source.from, to: source.to });
            continue;
          }
          seen.value += shift.value;
          seen.shifts++;
          if (distance(source) > distance(seen)) Object.assign(seen, { from: source.from, to: source.to });
        }
      }
      return {
        head: `${total.toFixed(2)} (sum), ${shifts.length} shift(s)`,
        details: [...byElement.entries()]
          .sort((a, b) => b[1].value - a[1].value)
          .map(([el, s]) => `${el}  ≈${s.value.toFixed(2)} in ${s.shifts} shift(s), ${movement(s.from, s.to)}`),
      };
    },
  };
}

function movement(from: number | null, to: number | null): string {
  if (to === null) return `pushed out of view from ${from}px`;
  if (from === null) return `moved into view at ${to}px`;
  return `moved ${from}→${to}px`;
}

// ── text ────────────────────────────────────────────────────────────────────────────────────────

/**
 * `null` is deliberately absent: in some languages it is the word for zero and therefore ordinary
 * UI copy ("null results"). Add '\\bnull\\b' to `patterns` where it is not.
 */
const TEXT_PATTERNS = ['\\bundefined\\b', '\\bNaN\\b', '\\[object Object\\]', '\\{\\{|\\}\\}', '\\$\\{[^}]*\\}'];

interface TextFinding {
  kind: 'pattern' | 'i18n' | 'truncated';
  match: string;
  where: string;
  excerpt: string;
}

function textSensor(config: TextConfig, run: SensorRun): Sensor {
  let findings: TextFinding[] | null = null;

  return {
    async beforeScreenshot() {
      await assertScope(run);
      const raw = await inPage(run.page, scanText, {
        scope: run.scope,
        patterns: [...TEXT_PATTERNS, ...(config.patterns ?? [])],
        i18nKeys: config.i18nKeys !== false,
      });
      const ignore = (config.ignore ?? []).map(entry => ({ entry, pattern: toRegExp(entry) }));
      const unique = new Map(raw.map(f => [`${f.kind}|${f.match}|${f.where}`, f]));
      findings = [...unique.values()].filter(
        f => !ignore.some(({ entry, pattern }) => entry === f.match || pattern?.test(textLine(f))),
      );
    },

    report() {
      if (!findings) throw new Error('text did not run');
      return { head: findings.length ? `${findings.length} finding(s)` : 'clean', details: findings.map(textLine) };
    },
  };
}

function toRegExp(source: string): RegExp | null {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

function textLine(f: TextFinding): string {
  switch (f.kind) {
    case 'pattern':
      return `pattern "${f.match}" in ${f.where}: "${f.excerpt}"`;
    case 'i18n':
      return `i18n key "${f.match}" in ${f.where}`;
    case 'truncated':
      return `truncated (${f.match}) ${f.where}: "${f.excerpt}"`;
  }
}

/**
 * Runs in the browser, via inPage: visible text and the attributes that carry text a screenshot
 * barely shows (placeholder, aria-label, title, alt, button values) — i18n leaks hide there. RegExps
 * travel as sources because they do not survive serialisation.
 */
function scanText(
  arg: { scope: string | null; patterns: string[]; i18nKeys: boolean },
  describe: (el: Element) => string,
): TextFinding[] {
  const EXCERPT = 40;
  const TLDS = ['de', 'com', 'org', 'net', 'io', 'eu', 'at', 'ch'];
  // A file name has the shape of a key as much as a domain does.
  const EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'mp4', 'html', 'js', 'ts', 'json', 'css'];
  const ATTRIBUTES = ['placeholder', 'aria-label', 'title', 'alt'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  // The input types whose value shows as text. Never password: its value is a secret, not copy.
  const TEXT_INPUTS = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'submit', 'button']);

  const visible = (el: Element) => el.checkVisibility({ visibilityProperty: true });
  const excerpt = (text: string, index: number) => {
    const flat = text.replace(/\s+/g, ' ');
    const start = Math.max(0, Math.min(index - 12, flat.length - EXCERPT));
    const cut = flat.slice(start, start + EXCERPT).trim();
    return `${start > 0 ? '…' : ''}${cut}${start + EXCERPT < flat.length ? '…' : ''}`;
  };
  const patterns = arg.patterns.map(source => new RegExp(source, 'g'));
  const i18n = /\b[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+){2,}\b/g;

  const findings: TextFinding[] = [];
  const check = (text: string, where: string, i18nKeys = arg.i18nKeys) => {
    for (const pattern of patterns) {
      for (const m of text.matchAll(pattern)) {
        findings.push({ kind: 'pattern', match: m[0], where, excerpt: excerpt(text, m.index) });
      }
    }
    if (!i18nKeys) return;
    for (const m of text.matchAll(i18n)) {
      const key = m[0];
      const last = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
      const before = text[m.index - 1];
      const after = text[m.index + key.length];
      if (key.includes('www.') || before === '@' || after === '@') continue;
      if (TLDS.includes(last) || EXTENSIONS.includes(last) || /^v?[\d.]+$/i.test(key)) continue;
      findings.push({ kind: 'i18n', match: key, where, excerpt: excerpt(text, m.index) });
    }
  };

  const roots = arg.scope ? [...document.querySelectorAll(arg.scope)] : [document.body];
  for (const root of roots) {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (SKIP.has(el.tagName) || !visible(el)) continue;
      const where = describe(el);

      const ownText = [...el.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent ?? '')
        .join(' ');
      if (ownText.trim()) check(ownText, where);

      for (const name of ATTRIBUTES) {
        const value = el.getAttribute(name);
        if (value) check(value, `${where}[${name}]`);
      }
      // The property, not the attribute: Angular writes form values as properties, so an autocomplete
      // without displayWith shows [object Object] in a field whose value attribute is empty. Patterns
      // only — a field holds data, and data such as "u.a.m." has the shape of a key.
      const field = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type));
      if (field && el.value) check(el.value, `${where}[value]`, false);

      if (!ownText.trim()) continue;
      const style = getComputedStyle(el);
      if (style.display === 'inline' || style.display === 'contents') continue;
      // Collapsed to nothing (a label folded away until hover) is hidden, not truncated: no text shows
      // at all. So is the 1px box of a screen-reader-only element (cdk-visually-hidden, the live
      // announcer Material fills for every snackbar): it is clipped by design.
      if (el.clientWidth <= 1 || el.clientHeight <= 1) continue;
      const wide = el.scrollWidth > el.clientWidth + 1;
      const tall = el.scrollHeight > el.clientHeight + 1;
      const hides = (overflow: string) => overflow === 'hidden' || overflow === 'clip';
      const clamp = style.getPropertyValue('-webkit-line-clamp');
      const mode =
        style.textOverflow === 'ellipsis' && wide
          ? 'ellipsis'
          : clamp && clamp !== 'none' && tall
            ? 'clamp'
            : (hides(style.overflowX) && wide) || (hides(style.overflowY) && tall)
              ? 'clip'
              : null;
      if (mode) {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        findings.push({ kind: 'truncated', match: mode, where, excerpt: text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text });
      }
    }
  }

  const rank = { pattern: 0, i18n: 1, truncated: 2 };
  return findings.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

// ── html ────────────────────────────────────────────────────────────────────────────────────────

/**
 * No harness-side overrides against framework noise: on an Angular app `html-validate:standard`
 * raises nothing for custom elements or `_ngcontent-*` attributes (checked against /, 2026-09-28).
 * Should a framework need one, it goes here as a documented default that `rules` can override.
 *
 * Should the html sensor flag attributes or elements a UI framework emits on every page, the rule
 * goes here as a documented default rather than into every shot.config.ts.
 */
const HTML_DEFAULT_RULES: Record<string, unknown> = {};

type HtmlSource = 'dom' | 'raw' | 'dom+raw';

interface HtmlMessage {
  source: HtmlSource;
  severity: number;
  ruleId: string;
  message: string;
  where: string;
}

/**
 * The `dom` source validates `page.content()` — markup the browser's parser has already repaired, so
 * classic parse errors are gone from it. What it finds is what JavaScript built: duplicate IDs,
 * invalid attributes, interactive content nested inside interactive content. The parse errors only
 * the `raw` source sees, in the document response as the server sent it; for a SPA that is the
 * near-empty index.html, which is why `raw` is off by default.
 */
function htmlSensor(config: HtmlConfig, run: SensorRun): Sensor {
  let validator: HtmlValidate | null = null;
  let messages: HtmlMessage[] | null = null;
  const counts: Partial<Record<'dom' | 'raw', { errors: number; warnings: number }>> = {};
  let rawMissing = false;

  const validate = async (source: 'dom' | 'raw', markup: string): Promise<HtmlMessage[]> => {
    // Built here, not in the factory: a bad preset in the config is this sensor's error, not the shot's.
    validator ??= new HtmlValidate({
      extends: [config.preset ?? 'html-validate:standard'],
      rules: { ...HTML_DEFAULT_RULES, ...config.rules } as Record<string, RuleConfig[string]>,
    });
    const report = await validator.validateString(markup, `${source}.html`);
    const found = report.results.flatMap(result =>
      result.messages.map(m => ({
        source,
        severity: m.severity,
        ruleId: m.ruleId,
        message: m.message,
        where: m.selector ? shortSelector(m.selector) : `${m.line}:${m.column}`,
      })),
    );
    counts[source] = {
      errors: found.filter(m => m.severity === 2).length,
      warnings: found.filter(m => m.severity !== 2).length,
    };
    return found;
  };

  return {
    async beforeScreenshot(response) {
      const found = await validate('dom', await run.page.content());
      if (config.raw) {
        const type = response?.headers()['content-type'] ?? '';
        if (response && type.includes('text/html')) found.push(...(await validate('raw', await response.text())));
        else rawMissing = true;
      }
      messages = byFrequency(mergeSources(found));
    },

    report(detail) {
      if (!messages) throw new Error('html did not run');
      const sources = (['dom', 'raw'] as const).filter(source => counts[source]);
      const clean = sources.filter(source => !counts[source]!.errors && !counts[source]!.warnings);
      const parts = clean.length ? [`clean (${clean.join('+')})`] : [];
      for (const source of sources) {
        const { errors, warnings } = counts[source]!;
        if (errors || warnings) parts.push(`${errors} error(s)${warnings ? `, ${warnings} warning(s)` : ''} (${source})`);
      }
      if (rawMissing) parts.push('raw: no html document response');

      return { head: parts.join(', '), details: detail ? messages.map(htmlLine) : groupHtml(messages) };
    },
  };
}

/**
 * A finding both sources agree on is one finding, not two: the dom copies stay, relabelled
 * `dom+raw` — each occurrence of them, so a duplicate ID found twice still counts ×2 — and the raw
 * copies go.
 */
function mergeSources(messages: HtmlMessage[]): HtmlMessage[] {
  const key = (m: HtmlMessage) => `${m.ruleId}|${m.message}`;
  const raw = new Set(messages.filter(m => m.source === 'raw').map(key));
  const dom = new Set(messages.filter(m => m.source === 'dom').map(key));
  return messages.flatMap((m): HtmlMessage[] => {
    if (!raw.has(key(m)) || !dom.has(key(m))) return [m];
    return m.source === 'dom' ? [{ ...m, source: 'dom+raw' }] : [];
  });
}

/** Errors before warnings, then the rules that fire most often, each rule's messages together. */
function byFrequency(messages: HtmlMessage[]): HtmlMessage[] {
  const group = (m: HtmlMessage) => `${m.source}|${m.ruleId}`;
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(group(m), (counts.get(group(m)) ?? 0) + 1);
  return [...messages].sort(
    (a, b) =>
      b.severity - a.severity ||
      counts.get(group(b))! - counts.get(group(a))! ||
      group(a).localeCompare(group(b)),
  );
}

/** One line per rule; `messages` arrive in byFrequency order, which the grouping keeps. */
function groupHtml(messages: HtmlMessage[]): string[] {
  const groups = new Map<string, HtmlMessage[]>();
  for (const m of messages) {
    const key = `${m.source}|${m.ruleId}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups.values()]
    .map(group => {
      const first = group[0]!;
      return `[${first.source}] ${first.ruleId}${group.length > 1 ? ` ×${group.length}` : ''}  ${first.where}: ${first.message}`;
    });
}

function htmlLine(m: HtmlMessage): string {
  return `[${m.source}] ${m.ruleId}  ${m.where}: ${m.message}`;
}

/** html-validate spells out the path from <html>; the last three steps say where. */
function shortSelector(selector: string): string {
  const steps = selector.split(' > ');
  return steps.length > 3 ? steps.slice(-3).join(' > ') : selector;
}
