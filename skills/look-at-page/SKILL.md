---
name: look-at-page
description: Look at a rendered frontend page or seed local data via the e2e screenshot harness. Use when you need to see how a route renders, verify a UI/CSS change, screenshot a page, check for console/network errors, horizontal overflow, accessibility and contrast violations, layout shifts, i18n leaks, invalid HTML or what the last edit changed visually, or populate the local database with test data (where the project wired seeding). Triggers on "look at /route", "screenshot the page", "check this view", "does this render", "seed local data", "iterate on a UI change".
---

# Look at a rendered page

To look at a rendered page, use the screenshot harness rather than driving a browser by hand: it caches
the login, so a run costs one navigation instead of re-driving the multi-round-trip login every time.

For the wider decision of *which* browser surface to use (Playwright script vs. MCP vs. a browser extension
vs. raw CDP), and the security reasoning behind it, see `docs/browser-testing.md`. This skill is the
day-to-day dev loop: screenshot a route, seed data, type-check.

It needs the dev server running (`DEFAULT_BASE_URL` in `e2e/project.ts`; who starts it and who leaves it
alone: root `AGENTS.md`, section *Dev server*) and, once per machine, `npx playwright install chromium` inside
`e2e/`. On a machine where that port belongs to another project, prefix every command with
`BASE_URL=http://localhost:<port>`; a shot of the wrong app looks just as green, so check the `landed` line
and the PNG once. `--port` is a different thing (below).

An app without a login (`NO_LOGIN` in `e2e/login.ts`) needs none of the login, session or `E2E_USER` parts
of this skill: every shot is anonymous and reports `session    none`.

## Screenshot a route

```bash
npm run shot --prefix e2e -- /some/route     # --anon for public routes, --viewport=mobile, --full
```

It writes `tmp/shots/<route>.png` (repo root; `-<width>x<height>` appended for a non-default viewport, so a
desktop and a mobile shot of one route keep both PNGs) and prints a compact report: the URL actually landed on (so
a silent redirect back to login shows up), whether the login it used reached the route asked for, whether
the session was fresh or cached, console errors, failed requests, horizontal overflow, and five sensor
lines (below). **Read the report first and open the PNG only when a visual judgement is actually needed.**
Overflow, contrast and what moved are numbers there, not something to squint at.

An `assumes    NOT held …` line means a guard bounced the shot elsewhere and the PNG shows that page, not
the route you asked for. The line names the remedy that fits the login: follow it rather than reaching
for `npm run seed` by reflex. Usually the route wants a different test user (`E2E_USER`), or the one you
used lacks the data or role the route guards on. Without a login it means the app itself redirected: an
unknown route, or an id that does not exist.

Routes that carry an id from data (`/orders/:id`) need a real one: read it from the API (`curl` the
endpoint the list page calls) or click through in a throwaway script (below) and print `page.url()`. Then
pass the full path; `shot.ts` does not navigate for you.

| Flag | Effect |
|---|---|
| `--anon` | skip login entirely; right for public routes such as `/`, legal pages, the landing page |
| `--viewport=mobile\|tablet\|desktop` or `=375x812` | defaults to `1280x800` |
| `--full` | full-page instead of viewport-cropped; can paint a `<video>` over the overlay that really covers it, so verify video UI with a clipped shot |
| `--wait="text=…"` | hold until a selector appears, for async views |
| `--out=name` | override the output filename |
| `--fresh` | discard the cached session and log in again |
| `--headed` | show the browser, for a human watching |
| `--port=4201` | serve from a second dev server while the browser origin stays the configured one; only when an identity provider or a CORS list pins that origin, see below |

### The sensor lines

After `overflow` come `a11y`, `diff`, `cls`, `text` and `html`: one head line and at most three detail
lines each. They report, they never fail the run: the exit code only says whether the shot itself worked.

| Line | Tells you |
|---|---|
| `a11y` | WCAG violations and axe best practices, worst first: contrast, missing names, `target-size`, `landmark-unique`; `--detail=a11y` adds the measured ratio and the reason per node |
| `diff` | what changed since **your previous run of the same shot** (same `--out`, viewport, `--full`, login and `--port`), not since `main`, as a pixel count, and which elements sit in the changed bands; writes `<name>.diff.png` next to the shot. A run with `diff` left out keeps the baseline where it was |
| `cls` | which elements jumped while the page loaded, invisible in a shot taken afterwards; `pushed out of view` is an element shoved below the fold, not up to the top |
| `text` | `undefined`, `NaN`, `[object Object]`, `{{ }}`, raw i18n keys (also in `aria-label`, `placeholder`, `title`, `alt`; the patterns also in form field values), and clipped text: an ellipsis, a line clamp, or an `overflow: hidden` box narrower than its text. The last is also how an icon font ligature without a glyph shows up: the ligature name renders as text and overflows the icon's box |
| `html` | invalid markup in the rendered DOM: duplicate IDs, buttons in links, invalid attribute values |

A line ending in `(wrong page)` belongs to the page a guard sent you to: fix the `assumes` line first;
`diff` skips that shot and keeps its baseline. `<label> error: …` is the sensor failing, not the page; the
others still ran. The first shot of a name says `diff  baseline created`; the second one onwards compares.

| Flag | Effect |
|---|---|
| `--checks=a11y,text` | run only these sensors, while iterating on one thing |
| `--skip=diff,html` | run all but these |
| `--detail=a11y` | up to 20 lines for that sensor (one per node, with the reason); bare `--detail` for all |
| `--scope="main"` | a11y and text on a CSS subtree only, so header and footer findings stay out |
| `--reset-diff` | forget the diff baseline and start a new one, e.g. after switching branches |

What a sensor checks, and switching one off for good, is the human's call in `e2e/shot.config.ts`; the
flags can narrow that, never widen it (`disabled in shot.config.ts`). Leave the file alone unless asked.

`E2E_USER` / `E2E_PASSWORD` shoot as another login; the session cache is keyed by login
(`e2e/.auth/state-<slug>.json`), so switching users costs one login each and never serves the previous
user's session. The project's test users are listed in the root `AGENTS.md`, section *Test users* (one
row saying so when the app has no login).

**If the configured port is taken and you still need to see *your* branch** (another session or worktree
owns the dev server) start a second *frontend* dev server on another port. Whether `--port` or `BASE_URL`
is the tool depends on one thing: does anything pin the browser's origin to the configured port? An
identity provider's redirect-URI list and an API's CORS list do; an app without a login whose API is
proxied by the dev server does not. Without such gatekeepers, `BASE_URL=http://localhost:4201` is right
and `--port` is wrong (it would keep the browser on the other project's port). With them, shoot with `--port`:

```bash
# start the project's dev server a second time on :4201, then
npm run shot --prefix e2e -- /some/route --port=4201
```

It keeps the browser's origin on the configured one, which is what the identity provider's redirect URI
and the API's CORS list accept, and serves the bytes from `:4201`. Nothing is reconfigured, the other
server is never contacted, and the cached login still applies. `BASE_URL=…4201` is **not** a substitute:
that changes the origin, which is the thing being checked. Only the frontend may be doubled; whether a
second backend is safe (shared database, migrations) is the project's call, root `AGENTS.md`.

## Seed local data

Seeding is optional: a project without a registration has no `seed.ts` (the adoption deleted it), and its
data comes from wherever the root `AGENTS.md`, section *Dev server*, says (a fixture at backend start, a
SQL file). If `e2e/seed.ts` exists and an authenticated route renders empty or errors, the local database
has no data for that user. Seed it by driving the real UI flows, which doubles as a local check that those
flows still work:

```bash
npm run seed --prefix e2e -- --count=3
```

It **refuses to run against anything but a local server**, and ends by printing the `E2E_USER=… E2E_PASSWORD=…`
line that points a shot at an account it just made. Seeding is optional in this harness: `seed.ts` is a
skeleton until the project filled it in. If `e2e/seed.ts` still carries adapt markers (the `adopt-harness`
skill works them), seeding is not wired yet; use a test user from the table instead.

## After touching anything under `e2e/`

The scripts and the specs share their form steps via `e2e/flows.ts`: change a login, wizard or form
selector *there*, not in five places. Then type-check: node strips types at runtime without verifying
them, so tsc is the only thing that will tell you:

```bash
npm run typecheck --prefix e2e
```

## Scratch files

A one-off script written while looking at a page goes in `e2e/tmp/`, gitignored, and the only place from
which it can import `playwright` and `./flows.ts` (the repo root has no `node_modules`; node resolves them
from the script's own directory, whatever the working directory). Run it from the repository root with
`node e2e/tmp/<name>.ts`; its PNGs go to `<repo>/tmp/shots/`, next to the harness's own. Keep it only
if the next person would run it again; then it belongs next to `shot.ts` with an entry in `e2e/package.json`.
