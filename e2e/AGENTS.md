# E2e - Playwright specs and the screenshot harness

Two things live here and share one toolbox: the Playwright suite CI runs, and the scripts an agent uses to
look at the running app. This file is what you need when you change something in here. Every place that
has to be adapted to a new project is a comment starting with the word ADAPT and a colon; `npm run doctor`
lists them, and `project.ts` holds most of them.

## Layout

| File | What it is |
|---|---|
| `project.ts` | the project profile: dev server URL and start command, allowed hosts, redirecting routes and guard pages, UI framework class prefixes, source directories and file kinds, the backend's Maven project and JaCoCo port; every other file reads the project's facts from here |
| `doctor.ts` | checks the environment (node, Chromium, what answers on `BASE_URL`, gitignore, agent file, a foreign JaCoCo agent) and lists the ADAPT markers left |
| `shot.ts` | renders one route of the running dev server, writes a PNG, prints a report; pays the login once and caches it under `.auth/` |
| `shot-sensors.ts`, `shot.config.ts` | the report's five sensors (a11y, diff, cls, text, html) and their settings |
| `shot.selftest.ts`, `shot-fixtures/` | proves each sensor fires on a broken static page and stays quiet on a clean one |
| `cli.ts` | the `--key=value` flag parsing `shot.ts` and `seed.ts` share |
| `login.ts` | the only file that knows how this app logs in: `login`, `isLoggedIn`, `DEFAULT_USER`, `sessionSlug`; `NO_LOGIN` for an app without one |
| `flows.ts` | the form-driving steps shared by the scripts and the specs |
| `seed.ts` | seeds the local stack by driving the real registration flow; optional, deleted in projects without a registration |
| `test-accounts.ts`, `global-setup.ts`, `global-teardown.ts` | reset the e2e accounts before and after a suite run |
| `tests/` | the specs, one per journey |
| `fixtures.ts` | the `test` every spec imports: a `page` whose coverage is collected, and `newSession` for a second login |
| `coverage.ts`, `backend-coverage.ts`, `coverage-gaps.ts` | which changed lines an e2e flow executes (section at the end) |
| `playwright.config.ts`, `playwright.coverage.config.ts` | the runner's config, and the same config with coverage switched on for `npm run test:coverage` |
| `tsconfig.json`, `eslint.config.js` | the type check and the lint, both load-bearing for the two runtimes (next section) |
| `tmp/` | throwaway scripts of exploratory agents, gitignored |

Commands are the scripts in `package.json`. From the repository root, run them as
`npm run <script> --prefix e2e -- <args>`: a compound `cd e2e && …` re-prompts for permission in most
agent sandboxes even when the command itself is allowed.

## Two runtimes, one `flows.ts`

`flows.ts` holds one copy of every step that drives one of the app's forms, so a renamed field breaks in
one place instead of five. `login.ts` holds the login the same way, and is the only file allowed to know
how the app authenticates — `shot.ts`, `seed.ts` and the specs import `login`, `isLoggedIn` and
`DEFAULT_USER` from there and nothing auth-related from anywhere else.

The specs go through the Playwright runner; `shot.ts` and `seed.ts` through plain `node`, which strips
types natively (Node ≥ 23.6) without checking them. Hence:

- Nothing in `flows.ts` or `login.ts` may import a **value** from `@playwright/test`. `Page` comes in as
  `import type`, which is erased before node sees it, and waits use `locator.waitFor()` rather than
  `expect()`. Assertions stay in the specs; a step that fills a form deliberately does not submit it when
  a spec wants to assert something between filling and submitting.
- `npm run typecheck` (`tsc --noEmit`) is the only thing that checks the scripts as a whole — the one
  exception is `npm run shot:selftest`, which covers the sensors alone. Run the typecheck after every
  change in here; node will happily run a type error.
- Three `tsconfig.json` settings are load-bearing: `allowImportingTsExtensions` (node resolves the
  specifier it is given, so imports carry a real `.ts` extension), `erasableSyntaxOnly` (rejects `enum`,
  `namespace` and parameter properties, which node cannot strip — a compile error here would otherwise be a
  runtime crash) and `verbatimModuleSyntax` (forces `import type`). `"type": "module"` in `package.json`
  is what makes `import` work at all, and why `eslint.config.js` is ESM.

## Directories the scripts write

| Path | Holds | Written by |
|---|---|---|
| `<repo>/tmp/shots/` | every PNG, and `<name>.diff.png` of the diff sensor | `shot.ts`, exploratory agents |
| `<repo>/tmp/shots/.baseline/` | the diff sensor's previous run per name, viewport, login and serving port | `shot.ts` |
| `e2e/.auth/state-<login-slug>.json` | one cached browser session per login | `shot.ts` |
| `e2e/tmp/` | throwaway scripts | exploratory agents |
| `e2e/coverage/` | the coverage reports | `coverage.ts` |

All of them are gitignored. Throwaway scripts belong in `e2e/tmp/` and nowhere else: the repository root
has no `node_modules`, so a script anywhere else cannot resolve `playwright` or `./flows.ts`. Node resolves
both from the script's own directory, so run them from the repository root as `node e2e/tmp/<name>.ts` —
the form the permission allowlist names; a compound `cd e2e && …` would re-prompt.

**Browsers may not be installed on the host.** `npx playwright install chromium` once (~150 MB), or drive
an installed Chrome with `chromium.launch({ channel: 'chrome' })`.

## `shot.ts`

`BASE_URL` defaults to `DEFAULT_BASE_URL` in `project.ts`, the project's canonical dev server address; a
machine where that port belongs to something else sets the variable. `E2E_USER` / `E2E_PASSWORD` override
`DEFAULT_USER`; the cached session is keyed by that login, so switching users costs one login each and
never serves the previous user's session.

**An app without a login** sets `NO_LOGIN` in `login.ts`. Every shot is then anonymous (`session none`), no
session is cached, and `assumes` still reports a redirect away from the requested route, which without
guards means an unknown route or id.

**`assumes`.** Every authenticated shot rests on the login being the one the route was built for — a
role, an onboarding step completed. When it is not, a guard answers with a different page and the PNG
shows *that* page under the requested route's filename: a wrong answer that looks like a right one. Any
redirect away from the requested route is therefore reported as a failed assumption — the exceptions are
the `REDIRECTING_ROUTES`, whose whole job is to send a visitor elsewhere. The remedy it names depends on
the login (`seedRemedy`): `seed.ts` completes exactly one existing account, the default user; every other
account it *creates*, and the suite's own accounts are reset on every run and restored by nothing.

**The storageState is deliberately not wired into the test projects.** `smoke.spec.ts` tests logging in,
and any spec that registers a user or starts from the login form needs an unauthenticated session.

Two implementation notes that are easy to re-break:

- **The login runs at desktop width** regardless of `--viewport`. Below the mobile breakpoint the
  login and logout controls of most headers collapse into a burger menu, so a mobile-width login finds
  neither. `shot.ts` sets the viewport before calling `login()`, and the locators in `login.ts` may
  assume it.
- **Auth detection races both header states** rather than sampling one (`isLoggedIn` in `login.ts`).
  `locator.isVisible()` is a point-in-time check with no wait; called right after `load` it reports
  "logged out" before the app has resolved its auth state, and the script then hunts for a login button
  the app will never render.

### Sensors

`shot-sensors.ts` appends five lines after `overflow`. Each sensor hooks into a fixed sequence in `main`,
and the sequence is the part that is easy to break:

- **text and html read the page before the screenshot**, a11y and the diff mapping after it. axe and the
  diff's pixel-to-element mapping scroll, so **cls reads its shifts first** (`RUN_ORDER`, which is not the
  report order), and console errors and failed requests are taken before any of them.
- **The layout-shift observer and a frozen clock go in after the login**: the observer belongs to the route,
  and a fixed `Date` must not touch the token exchange.
- **The diff baseline is replaced after the report**, and not at all when `assumes` did not hold — a wrong
  page would become what the next right one is compared against. Baselines stay local and uncommitted: CI
  renders on Linux, the agents on macOS.
- **A sensor never fails the shot.** Every hook is caught per sensor and becomes `<label> error: …`; anything
  a sensor could throw inside `page.screenshot` (a bad `mask` selector) is checked in an earlier hook.
- The context runs with `reducedMotion: 'reduce'` so contrast and diff do not measure a transition halfway.
  An app that honours `prefers-reduced-motion` shows that branch in the PNG — a pulsing button, for one,
  never appears in a shot.
- Browser-side functions (`scanText`, `observeLayoutShifts`, `elementsAtBands`) are serialised alone, so
  nothing they close over reaches the page. The one helper they share, `describeElement`, travels as source
  beside them: `inPage` for `page.evaluate`, the init script for the layout-shift observer.

`shot.config.ts` belongs to the human, the flags to the agent: `false` there beats `--checks`. `SHOT_CONFIG`
swaps the file and `SHOT_OUT_DIR` the output directory — both exist for the self-test, which serves
`shot-fixtures/` from a throwaway `node:http` server and runs the harness with `--anon` against it. Run
`npm run shot:selftest` after touching a sensor. **`clean.html` is never made worse to get it green**: a false
positive there is fixed in the sensor. The fixed ones so far — labels collapsed to zero width, prefixed
versions such as `v2.4.1`, file names — are commented where they are filtered. Not part of CI; it needs
Chromium.

### `--port`: a second frontend while `:4200` belongs to someone else

The worktree case: `:4200` and the API port are another session's servers, and the rule *leave a running
server alone* leaves you with no way to see your own branch. A second frontend dev server on another port
is free — **a second backend usually is not**: it runs migrations against the shared local database and
migrates it out from under every other worktree. Point the second frontend at the backend already running.

`--port` is for one situation only: something pins the browser's origin to the configured port. Without
such a gatekeeper (no identity provider, no CORS list, an API proxied by the dev server) plain
`BASE_URL=http://localhost:4201` is the tool, and `--port` would keep the browser on somebody else's server.

**Two origin checks pin the naive second frontend to `:4200`.** A typical identity provider allows only
`http://localhost:4200/*` as redirect URI and web origin, so a frontend on `:4201` renders but bounces every
authenticated route with *invalid redirect URI*. And the API's CORS list names `http://localhost:4200` alone
— so even past the login the API refuses a page served from `:4201`. `BASE_URL=http://localhost:4201`
therefore does *not* get you there. Both can be widened at the source, but each mutates something every
parallel session shares; reach for that last.

`--port` needs neither. The browser's address stays `http://localhost:4200` and `shot.ts` swaps the port on
each request on its way out (`context.route`), so the identity provider accepts the redirect, CORS accepts
the API calls, and the cached `.auth` session — filed under that origin — still applies. Only the frontend
origin is swapped; the API and the identity provider on their own ports are still the real ones, whose
opinion of the origin is the thing being satisfied. The report names the source (`served :4201 — origin
kept at …`) so a proxied shot cannot pass for the real one.

Nothing of the other session's is touched: its `:4200` server is never contacted, because requests are
intercepted inside the browser before they reach the network, and the live-reload WebSocket — which
`context.route` does not cover — is closed deliberately; only sockets to the frontend origin, the app's own
sockets to the API keep running. A dead `--port` therefore fails loudly
(`is a dev server running on :9999?`) rather than falling back to `:4200`.

Two side effects. Chrome classifies a page whose responses were fulfilled by the test as living in the
*public* address space and blocks its XHRs to the API on another localhost port as private-network requests
— so `--port` launches Chrome with those checks disabled, and only `--port` does, since they weaken the
browser. And because the live-reload socket is closed, a Vite-based dev server logs one console error per
run; the harness drops that one message, by its own text and only while proxying, so the `console` line
stays meaningful.

The same interception fakes states without touching real data — fulfilling one API route with a 404
photographs the "nothing here yet" state without deleting the seeded record. That is a two-line
`context.route` in a throwaway script, not a flag. Prefer it to mutating the local database, which the other
session is also reading.

## `seed.ts` (optional)

Drives the same registration flow the specs assert on, so running it is also a **local check that
registration still works**. A project without a registration deletes the file and its npm script.

- It ends by completing `DEFAULT_USER` (unless `--skip-default`), because that is the user `shot.ts` logs
  in as. Accounts seeded per run (`--count`, default 1) are `seed-<stamp>-<n>@example.com`, all with
  `SEED_PASSWORD`. When it created at least one, the last line is the `E2E_USER=… E2E_PASSWORD=…` command
  that points a shot at an account it just made.
- **It refuses to run against anything but this machine**, and against a packaged stack that publishes the
  dev server's port: "something is listening" cannot tell the two apart, so the `Server` header is the
  discriminator — a dev server sends none, nginx does.

## The specs and the accounts they need

`smoke.spec.ts` opens `/`, logs `DEFAULT_USER` in through `login.ts` and asserts the session exists. It is
the one spec meant to run against a deployed stack after every deploy, so it deliberately does not assert
*which* page the login lands on.

**Every run starts from accounts that do not exist.** `global-setup.ts` and `global-teardown.ts` reset
every account in `TEST_ACCOUNTS` (`test-accounts.ts`): the login stays, the application forgets what the
account carried. So every run passes the onboarding again, and a failed run leaves nothing behind for the
next one. The account deletion a UI offers cannot do this — it deletes the login too. The reset is optional:
without `E2E_RESET_URL` it is a no-op that says so, and the specs have to cope with whatever the accounts
carry.

The suite's dependency is `baseURL` alone, so it also runs straight against the local stack — writing into
the local database; a run that dies mid-test leaves rows behind.

## Coverage

Use this to learn whether any e2e flow runs the code you changed.

```bash
npm run test:coverage --prefix e2e                   # full suite with coverage on
npm run coverage:gaps --prefix e2e -- --base main    # changed lines no flow executed
```

- **What must run:** the frontend **dev server** at `baseURL`, because a production build has no source maps and the run stops at the first page. Backend numbers also need a local backend with the JaCoCo agent attached (`BACKEND_START_COMMAND` in `project.ts`). Without the agent, or without a `pom.xml` at `BACKEND_DIR`, the run measures the frontend only and says why. That is not an error.
- **The agent port is per project:** the run resets and dumps whatever agent answers on `JACOCO_AGENT_PORT`. Two projects on one machine using JaCoCo's default 6300 would measure each other; `npm run doctor` warns when something already answers there.
- **Starting the backend:** don't restart a backend someone else started just to attach the agent; ask the human.
- **`--base`:** defaults to `DEFAULT_BASE_REF` in `project.ts`. Pass `--base <ref>` on a branch that shares no history with it. The diff runs from the merge base to the working tree, so uncommitted and untracked changes count too.
- **What you get:**
  - For humans: HTML at `e2e/coverage/frontend/index.html` and in the backend's `target/site/jacoco-e2e/index.html`.
  - For you: `coverage:gaps` prints only the changed files with gaps, as line ranges (`uncovered 42-48; branch never taken 51`), plus a total.
  - For CI and tools: `e2e/coverage/frontend/lcov.info`, `coverage-summary.json` and the backend's `jacoco.xml`.
- **Caveats:**
  - A covered line only means some flow executed it, not that an assertion checked it. An uncovered line is the signal worth acting on. Close it with a test of the behaviour behind it, not a test that just visits the line.
  - Backend code that only runs at startup (configuration, wiring) always shows as uncovered, because the counters are zeroed after startup.
  - If the backend was recompiled after it started, those classes read 0 % and `coverage:gaps` prints a WARNING. Restart the backend with the agent and re-run before trusting backend gaps.
  - "Report predates the last edit": re-run `test:coverage`.
  - Only pages opened through the `page` fixture or `newSession` from `fixtures.ts` are measured. Popups, `context.newPage()` and pages a spec closes itself drop out silently.
  - Templates (.html) are not measured; their source-map lines point into compiled render functions.
  - A Vite app imports its modules by their own names (`/src/main.tsx`); every such extension has to be in `FRONTEND_SOURCE_EXTENSIONS` (project.ts), or the run stops with a message naming the first script it could not place.
- To measure one spec: `npm run test:coverage --prefix e2e -- tests/<file>.spec.ts`.
