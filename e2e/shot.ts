#!/usr/bin/env node
/**
 * Screenshot harness for the agent-driven UI loop.
 *
 * Renders one route of the running dev server, writes a PNG, and prints a compact
 * report. The login is paid once and cached, so iterating on a view costs one
 * navigation. Everything observable is printed as text, which keeps opening the
 * PNG optional rather than mandatory.
 *
 * It assumes the login is the one the route was built for — otherwise a guard sends the request
 * elsewhere and the shot shows that page instead of the one asked for. The `assumes` line in the
 * report says whether that held, so a shot of the wrong page cannot pass for the right one, and
 * it names the fix: `npm run seed` for the default user, a freshly seeded account for any other.
 *
 *   npm run shot -- /dashboard
 *   npm run shot -- / --anon
 *   npm run shot -- /imprint --viewport=mobile --full
 *   npm run shot -- /projects/new --wait="text=Project details" --headed
 *   npm run shot -- /dashboard --port=4201    # a second frontend, while :4200 is someone else's
 *
 * After `overflow` come five sensors (shot-sensors.ts), each one head line and at most three detail
 * lines: a11y (axe), diff (against this shot's previous run), cls (what jumped while loading), text
 * (undefined, NaN, raw i18n keys, clipped text) and html (html-validate). They report, they never
 * fail the run — the exit code still says only whether the shot itself worked. Their knobs are in
 * shot.config.ts, which belongs to the human; the flags below can narrow what it allows, never widen.
 *
 *   npm run shot -- /dashboard --checks=a11y,text     # only these sensors
 *   npm run shot -- /dashboard --skip=diff,html       # all but these
 *   npm run shot -- /dashboard --detail=a11y          # up to 20 lines for a11y; bare --detail for all
 *   npm run shot -- /dashboard --scope="main"         # a11y and text on a subtree, not header and footer
 *   npm run shot -- /dashboard --reset-diff           # forget the diff baseline, start a new one
 *
 * The diff baseline is the previous run of the same --out name, viewport (and --full), login and
 * serving port, kept in tmp/shots/.baseline/: it answers "what did my last edit change". A run
 * without the diff sensor leaves it where it was. A shot the `assumes` line
 * marks as the wrong page skips the diff and leaves the baseline alone, and every other sensor
 * says `(wrong page)` — findings about the page a guard sent you to are not findings about yours.
 * `npm run shot:selftest` proves each sensor against the static pages in shot-fixtures/.
 */

import { chromium } from 'playwright';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { parseFlags } from './cli.ts';
import { DEFAULT_USER, NO_LOGIN, isLoggedIn, login, sessionSlug } from './login.ts';
import { TEST_ACCOUNTS } from './test-accounts.ts';
import {
  ALLOWED_HOSTS,
  BASE_URL,
  FRONTEND_DEV_SERVER_COMMAND,
  GUARD_TARGETS,
  REDIRECTING_ROUTES,
  REPO_ROOT,
  frontendDevServerOnPort,
} from './project.ts';
import {
  LABEL_WIDTH,
  createSensors,
  parseSensorFlags,
  type SensorFlags,
  type SensorRun,
  type ShotConfig,
} from './shot-sensors.ts';

// SHOT_CONFIG swaps the sensor config for another one, resolved against the working directory — the
// self-test's fixtures use it to run with their own settings without touching the real one.
const CONFIG_URL = process.env.SHOT_CONFIG
  ? pathToFileURL(resolve(process.cwd(), process.env.SHOT_CONFIG)).href
  : new URL('./shot.config.ts', import.meta.url).href;
const CONFIG = ((await import(CONFIG_URL)) as { default: ShotConfig }).default;

const USER = DEFAULT_USER;

// One cached session per login. A single shared file hands the next run whatever session
// happened to be lying there: ensureLoggedIn only asks whether *somebody* is signed in, so a shot
// with E2E_USER set would silently reuse the previous user's session and render their page.
const SESSION_KEY = sessionSlug(USER);
const STATE_FILE = fileURLToPath(new URL(`./.auth/state-${SESSION_KEY}.json`, import.meta.url));
// Paths in the report are shown relative to REPO_ROOT (project.ts), e2e/'s parent.
// SHOT_OUT_DIR exists for the self-test, which must not leave its fixtures' shots and baselines here.
const SHOT_DIR = process.env.SHOT_OUT_DIR
  ? resolve(process.cwd(), process.env.SHOT_OUT_DIR)
  : join(REPO_ROOT, 'tmp', 'shots');

interface Viewport {
  width: number;
  height: number;
}

const VIEWPORTS: Record<string, Viewport> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
};

const DEFAULT_VIEWPORT = VIEWPORTS.desktop!;

// ALLOWED_HOSTS (what `blocked` aborts), REDIRECTING_ROUTES and GUARD_TARGETS (what `assumes` allows
// and explains) are the project's facts and live in project.ts.

/** The port `--port` swaps away from: the origin every gatekeeper is configured for. */
const ORIGIN_PORT = new URL(BASE_URL).port;

/**
 * Chrome classifies a page whose responses were fulfilled by the test as living in the *public*
 * address space, and then blocks its XHRs to the API on another localhost port as private-network
 * requests — the page renders and sits empty. These switches turn that check off. Passed only
 * with `--port`: they weaken the browser, and an ordinary shot has no reason to carry them.
 */
const PRIVATE_NETWORK_ARGS = [
  '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,' +
    'PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks',
];

/** Set once `--port` is parsed, so the failure hint at the bottom can name the right server. */
let proxyTarget: string | null = null;

interface ShotOptions {
  route: string;
  anon: boolean;
  full: boolean;
  headed: boolean;
  fresh: boolean;
  wait: string | null;
  out: string | null;
  port: string | null;
  viewport: Viewport;
  sensors: SensorFlags;
}

function parseArgs(argv: string[]): ShotOptions {
  const { flags, positional } = parseFlags(argv);
  return {
    route: positional[0] ?? '/',
    // An app without a login (NO_LOGIN in login.ts) has nothing to log in to: every shot is anonymous.
    anon: flags.anon === true || NO_LOGIN,
    full: flags.full === true,
    headed: flags.headed === true,
    fresh: flags.fresh === true,
    wait: typeof flags.wait === 'string' ? flags.wait : null,
    out: typeof flags.out === 'string' ? flags.out : null,
    port: parsePort(flags.port),
    viewport: parseViewport(flags.viewport),
    sensors: parseSensorFlags(flags),
  };
}

function parseViewport(value: string | true | undefined): Viewport {
  if (value === undefined || value === true) return DEFAULT_VIEWPORT;

  const preset = VIEWPORTS[value];
  if (preset) return preset;

  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error(`--viewport must be one of ${Object.keys(VIEWPORTS).join('|')} or WIDTHxHEIGHT, got "${value}"`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * `--port=4201` serves the app from a second dev server while the browser's address stays on
 * [BASE_URL].
 *
 * Both gatekeepers of a typical local stack check the *origin*, and the origin includes the port:
 * the identity provider allows only `http://localhost:4200/*` as redirect URI, and the API lists
 * its allowed CORS origins. A frontend served on another port is therefore a different site to
 * both, and bounces. Pointing `BASE_URL` at it does not help — that changes the origin, which is
 * the thing being checked.
 *
 * So the port is swapped per request instead (see the route handler): the browser, the identity
 * provider, the API and the cached session all keep seeing [BASE_URL], while the bytes come from
 * here. That is what makes a worktree's frontend viewable beside another session's, with nothing
 * reconfigured and nothing of theirs touched.
 */
function parsePort(value: string | true | undefined): string | null {
  if (value === undefined || value === true) return null;
  if (!/^\d+$/.test(value)) throw new Error(`--port must be a port number, got "${value}"`);
  if (value === ORIGIN_PORT) {
    throw new Error(`--port ${value} is already ${BASE_URL} — drop the flag`);
  }
  return value;
}

/** The host the page's bytes come from: BASE_URL's, unless `--port` swaps them in from elsewhere. */
function servedHost(port: string | null): string {
  const served = new URL(BASE_URL);
  if (port) served.port = port;
  return served.host;
}

function slugify(route: string): string {
  const cleaned = route.replace(/^\/|\/$/g, '').replace(/[^a-zA-Z0-9]+/g, '-');
  return cleaned || 'home';
}

/**
 * A restored session usually lands straight on the app without ever rendering the login form —
 * an identity provider's own SSO cookie included. Filling the form (login.ts) is the fallback for
 * an expired or absent session, which makes this safe to call unconditionally.
 *
 * Runs at desktop width regardless of the requested viewport: below the mobile breakpoint the
 * login and logout controls of most headers collapse into a burger menu, and the login is
 * plumbing rather than the thing under test.
 */
async function ensureLoggedIn(page: Page): Promise<'cached' | 'fresh'> {
  await page.setViewportSize(DEFAULT_VIEWPORT);
  await page.goto(BASE_URL, { waitUntil: 'load' });

  if (await isLoggedIn(page)) return 'cached';

  await login(page, USER);
  return 'fresh';
}

/**
 * seed.ts completes exactly one existing account, the default user; every other account it touches
 * it creates. So for any other login "run the seed" repairs nothing — least of all for the suite's
 * own accounts, which every suite run resets again.
 */
function seedRemedy(): string {
  if (USER.username === DEFAULT_USER.username && !process.env.E2E_USER) {
    return 'npm run seed --prefix e2e (if this project kept seed.ts)';
  }

  const why = TEST_ACCOUNTS.some(account => account.username === USER.username)
    ? 'the e2e suite resets this account on every run (test-accounts.ts) and seed.ts does not restore it'
    : 'seed.ts completes no account but the default user';
  return (
    `${why}. Seed a fresh one — npm run seed --prefix e2e -- --count=1 --skip-default — ` +
    'and pass the login it prints as E2E_USER / E2E_PASSWORD'
  );
}

/**
 * Every authenticated shot rests on the login being the one the route was built for. When it is
 * not, a guard answers with a different page and the PNG shows *that* page under the requested
 * route's filename — a wrong answer that looks like a right one. So the assumption is reported
 * rather than merely documented.
 */
function assumesLine(opts: ShotOptions, landedUrl: string): { held: boolean; line: string } {
  // With a login, an anonymous shot assumes nothing: it is meant for the public pages. Without one,
  // every shot is anonymous and a redirect away from the route is still worth reporting.
  if (opts.anon && !NO_LOGIN) return { held: true, line: 'none — anonymous session' };

  const requested = new URL(opts.route, BASE_URL).pathname;
  const landed = new URL(landedUrl).pathname;
  const who = NO_LOGIN ? 'the visitor' : USER.username;

  if (landed === requested) return { held: true, line: `held — ${who} reached the route asked for` };
  if (REDIRECTING_ROUTES.has(requested)) {
    return { held: true, line: `held — ${requested} sent ${who} to ${landed}` };
  }
  if (NO_LOGIN) {
    return {
      held: false,
      line:
        `NOT held — the app sent ${who} from ${requested} to ${landed}, so this is a shot of ${landed}. ` +
        'Fix: check that the route exists and that any id in it is a real one',
    };
  }

  const reason = GUARD_TARGETS[landed];
  const remedy = reason ? seedRemedy() : 'set E2E_USER / E2E_PASSWORD to an account this route is built for';
  return {
    held: false,
    line:
      `NOT held — ${USER.username} ${reason ?? 'is not the login this route is built for'}, ` +
      `so this is a shot of ${landed}. Fix: ${remedy}`,
  };
}

/**
 * A horizontal scrollbar on the document is the single most common visual regression
 * and the one a screenshot hides rather than reveals - the shot is cropped to the
 * viewport, so the offending element is exactly what you cannot see.
 */
function findOverflow() {
  const doc = document.documentElement;
  if (doc.scrollWidth <= doc.clientWidth) return null;

  const offenders = Array.from(document.querySelectorAll('body *'))
    .filter(el => el.getBoundingClientRect().right > doc.clientWidth + 1)
    .slice(0, 5)
    .map(el => {
      const cls = el.classList[0] ? `.${el.classList[0]}` : '';
      return `${el.tagName.toLowerCase()}${cls} (right: ${Math.round(el.getBoundingClientRect().right)}px)`;
    });

  return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders };
}

/**
 * The live-reload socket is closed on purpose while proxying, and Vite's client reports that as a
 * page console error on every single run. It is the harness's own doing and says nothing about the
 * route, so it is dropped — by its own text, and only while proxying. A `console` line that is
 * never clean is a line nobody reads.
 */
// Vite-based dev servers (Angular >= 17, Vite, Next, Nuxt, SvelteKit) all log it this way; a webpack dev
// server logs something else and gets one known console error per --port run instead.
function isClosedHmrSocket(message: string, proxying: boolean): boolean {
  return proxying && message.startsWith('[vite]') && message.includes('websocket');
}

function report(lines: [string, string][]): void {
  for (const [label, value] of lines) {
    console.log(`${label.padEnd(LABEL_WIDTH)} ${value}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.fresh && existsSync(STATE_FILE)) {
    await rm(STATE_FILE);
  }

  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(fileURLToPath(new URL('./.auth/', import.meta.url)), { recursive: true });

  proxyTarget = opts.port;
  const browser = await chromium.launch({
    headless: !opts.headed,
    args: opts.port ? PRIVATE_NETWORK_ARGS : [],
  });
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: opts.viewport,
    // Settles CSS transitions for everything that reads the page, not just the screenshot (which has
    // `animations: 'disabled'`): a contrast measured mid-fade or a diff of half a transition is noise.
    reducedMotion: 'reduce',
    storageState: !opts.anon && existsSync(STATE_FILE) ? STATE_FILE : undefined,
  });

  const blockedThirdParty: string[] = [];
  const proxyFailures: string[] = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      blockedThirdParty.push(url.href);
      return route.abort();
    }
    // The frontend origin only. The API and the identity provider on their own ports have to
    // stay untouched — it is their opinion of the origin that the swap exists to satisfy.
    if (opts.port && url.port === ORIGIN_PORT) {
      const swapped = new URL(url.href);
      swapped.port = opts.port;
      try {
        return route.fulfill({ response: await route.fetch({ url: swapped.href }) });
      } catch {
        proxyFailures.push(swapped.href);
        return route.abort();
      }
    }
    return route.continue();
  });

  // `context.route` does not cover WebSockets, so the dev server's live-reload socket would be the
  // one request still going to the real BASE_URL — another session's server, which is the thing
  // --port exists to leave alone. It is refused there anyway (its build token does not match),
  // so closing it costs nothing and keeps that promise literally true. Only sockets to the frontend
  // origin: the app's own sockets to the API on its port carry data, and stay open.
  if (opts.port) await context.routeWebSocket(url => url.port === ORIGIN_PORT, ws => ws.close());

  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(`uncaught: ${err.message}`));
  page.on('response', res => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });

  // Desktop and mobile shots of one route must not overwrite each other's PNG: the viewport goes
  // into the name unless it is the default one or the caller named the file.
  const isDefaultViewport =
    opts.viewport.width === DEFAULT_VIEWPORT.width && opts.viewport.height === DEFAULT_VIEWPORT.height;
  const name = opts.out ?? `${slugify(opts.route)}${isDefaultViewport ? '' : `-${opts.viewport.width}x${opts.viewport.height}`}`;
  const shotPath = join(SHOT_DIR, `${name}.png`);
  const run: SensorRun = {
    page,
    outDir: SHOT_DIR,
    name,
    session: opts.anon ? 'anon' : SESSION_KEY,
    served: servedHost(opts.port).replace(/[^a-zA-Z0-9]+/g, '-'),
    viewport: opts.viewport,
    full: opts.full,
    scope: opts.sensors.scope,
    resetDiff: opts.sensors.resetDiff,
    shotPath,
    wrongPage: false,
    display: (path: string) => (path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length) : path),
  };
  const sensors = createSensors(CONFIG, opts.sensors, run);

  let session = NO_LOGIN ? 'none — this app has no login' : 'anonymous';
  try {
    if (!opts.anon) {
      session = await ensureLoggedIn(page);
      await context.storageState({ path: STATE_FILE });
      await page.setViewportSize(opts.viewport);
    }

    // Errors raised while the login form was on screen belong to the login, not to the route
    // under test; keeping them would blame the wrong page.
    consoleErrors.length = 0;
    failedRequests.length = 0;

    // After the login on purpose: the layout-shift observer belongs to the route, and a frozen clock
    // must not touch the token exchange.
    await sensors.beforeNavigation();

    const response = await page.goto(opts.route, { waitUntil: 'load' });
    // A dev server keeps a live-reload socket open, so networkidle never fires there. Give it a
    // short window to settle and move on regardless.
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
    if (opts.wait) await page.locator(opts.wait).first().waitFor({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);

    const landed = page.url();
    const assumes = assumesLine(opts, landed);
    run.wrongPage = !assumes.held;

    const overflow = await page.evaluate(findOverflow);
    await sensors.beforeScreenshot(response);
    await page.screenshot({ path: shotPath, fullPage: opts.full, animations: 'disabled', mask: sensors.mask() });

    // Taken before the sensors that come next: axe and the diff mapping scroll the page, and whatever
    // the app loads in response is the harness's doing, not the route's.
    const routeErrors = [...new Set(consoleErrors)].filter(
      e => !isClosedHmrSocket(e, opts.port !== null),
    );
    const routeFailures = [...new Set(failedRequests)];
    await sensors.afterScreenshot();
    // Not reset after login, unlike the two above: a third-party reference is worth
    // surfacing wherever it lives, and the login page is one of the places.
    const blocked = [...new Set(blockedThirdParty)];

    report([
      ['route', opts.route],
      ['landed', landed],
      // Without this the report would read as a shot of BASE_URL, which is exactly the server
      // whose code is *not* on screen.
      ...(opts.port
        ? [['served', `:${opts.port} — origin kept at ${BASE_URL}`] as [string, string]]
        : []),
      ['assumes', assumes.line],
      ['session', session],
      ['viewport', `${opts.viewport.width}x${opts.viewport.height}${opts.full ? ' (fullPage)' : ''}`],
      ['shot', run.display(shotPath)],
      ['console', routeErrors.length ? `${routeErrors.length} error(s)` : 'clean'],
      ...routeErrors.slice(0, 5).map((e): [string, string] => ['', `  ${e.slice(0, 160)}`]),
      ['network', routeFailures.length ? `${routeFailures.length} failed` : 'clean'],
      ...routeFailures.slice(0, 5).map((f): [string, string] => ['', `  ${f}`]),
      ['blocked', blocked.length ? `${blocked.length} third-party request(s)` : 'none'],
      ...blocked.slice(0, 5).map((b): [string, string] => ['', `  ${b}`]),
      ...(proxyFailures.length
        ? [['proxy', `${new Set(proxyFailures).size} request(s) unanswered on :${opts.port}`] as [string, string]]
        : []),
      [
        'overflow',
        overflow
          ? `${overflow.scrollWidth}px content in ${overflow.clientWidth}px viewport -> ${overflow.offenders.join(', ')}`
          : 'none',
      ],
      ...sensors.lines(),
    ]);
    await sensors.afterReport();
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(err => {
  console.error(`shot failed: ${err.message}`);
  console.error(
    proxyTarget
      ? `is a dev server running on :${proxyTarget}? (${frontendDevServerOnPort(proxyTarget)})`
      : `is the dev server running on ${BASE_URL}? (${FRONTEND_DEV_SERVER_COMMAND})`,
  );
  process.exit(1);
});
