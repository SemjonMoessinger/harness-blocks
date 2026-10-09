---
name: adopt-harness
description: Adapt harness-blocks (the e2e screenshot harness, seeder, coverage tooling and the look-at-page / exploratory-testing skills) to this codebase, one verified checkpoint at a time, asking the human only for what only they know. Use when asked to "adopt the harness", "set up harness-blocks", "install the screenshot harness", "work the ADAPT list", or when `npm run doctor --prefix e2e` still lists markers.
---

# Adopt harness-blocks

Every place the harness must change for this project is a code comment beginning exactly `ADAPT:` followed
by one sentence. They are concentrated in two files: `e2e/project.ts`, the project profile (URL, directories,
routes, ports), and `e2e/login.ts`, the login. The optional blocks carry a few more. `npm run doctor --prefix e2e`
is the to-do list **and** the progress indicator: it checks the environment and lists every marker left.
Resolve a marker, then delete it. Work the list in the order below, never in file order, and verify each
checkpoint before the next: a login that only *looks* wired wastes every later step.

**Never:** guess credentials (ask); commit `e2e/.auth/` or anything under `tmp/`; widen an identity provider's
redirect-URI list or an API's CORS list without asking; start, kill or restart a server you were not told to;
shoot a port you have not confirmed serves *this* app.

**Product files the adoption may touch**, and nothing else outside `e2e/`, the skill directories and
`docs/browser-testing.md`: the root `.gitignore` (one `tmp/` line, and a `!` exception when a legacy rule
swallows a harness file); the root agent file, created when there is none; the backend's `pom.xml` for the
coverage profile, only after asking; a CI workflow, only when asked.

## 0. Preconditions

Two answers shape the whole adoption: whether the app has a login, and which URL serves it. Ask for them and
for everything else in this table you cannot read from the repo in **one** message, then do everything that
does not depend on the answers while you wait. Do not proceed on assumptions about the login or the URL.

| Need | How to check | If unknown, ask |
|---|---|---|
| Node ≥ 23.6 | `node --version` | which version manager to use; plain `node` must strip types |
| The dev server URL, and that what answers there is *this* app | `npm run doctor --prefix e2e` prints what answers and its `<title>`; the README and the start script name the canonical port | "Which URL does the frontend dev server answer on, and is it this app?" On a machine where the canonical port belongs to another project the answer is `BASE_URL=<url>` in front of every command, never a change to `DEFAULT_BASE_URL` |
| Whether the app has a login | the routes file (guards?), the header (a login control?), the README | "How does a user log in: same-origin form, redirect to an identity provider, API token, or not at all?" — *not at all* is a normal answer: `NO_LOGIN` in `login.ts` |
| One test user with enough data (only with a login) | seed files, fixtures, the team | "Which local test user reaches the routes you care about, and where do its credentials live?" |
| Where `e2e/` lives | `ls e2e` | an existing `e2e/` with its own Playwright config: merge file by file and keep their config; a different name means replacing `--prefix e2e` in every script, skill and doc, so say so and prefer `e2e/` |

## 1. Install untouched, prove green

Copy `e2e/` from harness-blocks into the repo root **without** `node_modules/` and `.auth/` (a checkout
that was used carries both): `rsync -a --exclude node_modules --exclude .auth <harness-blocks>/e2e/ e2e/`.
Then:

```bash
npm install --prefix e2e
cd e2e && npx playwright install chromium && cd ..
npm run typecheck --prefix e2e        # exit 0, nothing printed after npm's own banner
npm run shot:selftest --prefix e2e    # exit 0; one ✓ per case, last line "N/N passed" with no ✗
npm run doctor --prefix e2e           # no ✗ line; the marker list it prints is the plan for step 2
```

Nothing project-specific has been touched yet, so typecheck and self-test must be green. If they are not, the
problem is the environment (Node version, missing Chromium, a sandbox without network), not the project. Fix
that first. `doctor` then checks what the project brings: a `✗` about a path "ignored by a pre-existing rule"
is Angular's old `e2e/*.js` line or similar in the root `.gitignore`; add `!e2e/eslint.config.js` under it. A
`✗` about `tmp/shots` needs one line, `tmp/`, in the root `.gitignore`. `doctor` compares the `<title>` of
whatever answers on the URL with the frontend's own `index.html`: a `✗` there means another project's server
on that port; prefix `BASE_URL=<url>` from then on. (A generic title such as "Frontend" matches a generic
`index.html` just as well, so a `✓` is only as strong as the title.)

## 2. Work the ADAPT list

`npm run doctor --prefix e2e` lists them, file and line. After every edit under `e2e/`: `npm run typecheck
--prefix e2e`, then `npm run lint --prefix e2e`.

### 2a. `login.ts` first

The only project-specific auth module. Two branches:

**The app has no login.** Set `NO_LOGIN = true` and delete the three other markers in `login.ts` without
working them: the code below is inert. Every shot is then anonymous and prints `session    none — this app
has no login`; `seed.ts` refuses to run, the suite resets no accounts, the smoke spec skips its login test.
Prove it with one shot of a real route without `--anon`:

```bash
npm run shot --prefix e2e -- /<a route>        # assumes  held — the visitor reached the route asked for, session  none
```

`assumes NOT held` here means the app itself redirected (a missing id, an unknown route), not a login problem.

**The app has a login.** It exports `TestUser {username, password}`, `DEFAULT_USER`, `login(page, user)`,
`isLoggedIn(page)` and `sessionSlug(user)`; replace the bodies, keep the signatures. `login` drives whatever
the app's login is; `shot.ts` sets a desktop viewport before calling it, so the locators may assume a desktop
header. `isLoggedIn` races two locators, the signed-in marker against the signed-out one, so it waits for the
app's decision instead of sampling the DOM; point both at what the header renders at desktop width, never at
a point-in-time check. Ask the human for the default test user's credentials and where they belong: a
local-only throwaway user may sit in `DEFAULT_USER`, anything else is read from `E2E_USER` / `E2E_PASSWORD`
and the placeholder stays.

Prove it in three shots, in this order:

```bash
npm run shot --prefix e2e -- / --anon                                    # assumes  none — anonymous session, session  anonymous
E2E_USER=<user> E2E_PASSWORD='<pw>' npm run shot --prefix e2e -- /<protected-route>   # session  fresh, assumes  held
E2E_USER=<user> E2E_PASSWORD='<pw>' npm run shot --prefix e2e -- /<protected-route>   # session  cached, assumes  held
```

`landed` on the first shot is whatever `/` resolves to in this app, which may be a redirect. `assumes NOT
held` on the second shot means the login ran but the user cannot reach that route: pick a route or user the
human names, not a guess. `session fresh` twice means the login worked but the restored session was not
recognised: `shot.ts` restores `e2e/.auth/state-<slug>.json` into the browser context, opens `BASE_URL` and
asks `isLoggedIn`; `fresh` again means the signed-in marker did not appear there, because it is not on that
page, or because the app keeps its session where `storageState` does not capture it (`sessionStorage`,
memory). Delete the `ADAPT:` markers in `login.ts` only after the third shot.

### 2b. `project.ts`, the profile

Every remaining fact about the project, in the order the file has them:

- `DEFAULT_BASE_URL`: the canonical port from the README, never the port that happens to be free on this
  machine. Per-machine differences go through `BASE_URL` on the command line; the snippet's *Dev server*
  section (step 4) already says so, a maintainer's port does not belong in a committed file.
- `FRONTEND_DEV_SERVER_COMMAND` and the `--port` variant: shown in error hints only.
- `ALLOWED_HOSTS`, `REDIRECTING_ROUTES`, `GUARD_TARGETS`: read the routes file. No guards means `{}`.
  Verify: a shot of a real route prints `blocked none`; if it lists a host the app needs, add it.
- `UI_FRAMEWORK_CLASS_PATTERN`: the class prefixes of a component library whose classes say nothing about
  the app (`mat-mdc-button`, `cdk-overlay`). A utility-class framework (Tailwind, daisyUI) needs no change:
  `.navbar` or `.btn-square` do name the element. Verify: the a11y detail lines read like the app's markup,
  not like a library's internals.
- `FRONTEND_SOURCE_DIR`: from the layout. `FRONTEND_SOURCE_EXTENSIONS`: `.ts` for a bundling dev server
  (Angular); a Vite app that imports `.tsx`, `.jsx`, `.vue` or `.svelte` modules by name lists each of them,
  otherwise `test:coverage` stops and names the first script it could not place. `DEFAULT_BASE_REF`: the branch the team merges into on its main
  remote (`git remote -v`); not whichever ref happens to share history with the branch you are on. Verify
  with `git merge-base HEAD <ref>`; on an unusual branch it may fail, then `--base` is per call.
- `tests/smoke.spec.ts` carries one more project fact: what the home page always renders for an anonymous
  visitor. Assert that, then `npm run test --prefix e2e` (its login test skips itself without a login).
- Backend part, only with a Maven backend: `BACKEND_DIR` and `JACOCO_AGENT_PORT`. The profile in
  `backend-coverage.ts` names its exec file through the `jacoco.destFile` property on purpose: keep that when
  pasting, a literal `<destFile>` silently defeats the harness's identity probe. If `doctor` says something
  already answers on that port, it is probably another project's backend on this machine and a coverage run
  would reset its counters: ask the human, and choose a free port for this project.

Verify: `npm run test --prefix e2e -- --list` names `smoke.spec.ts`, and `npm run doctor --prefix e2e` no
longer lists `project.ts`.

### 2c. `shot.config.ts`

The human's half of the sensors, one `checks` entry per sensor: `false` switches it off for good, an object
sets its knobs. Those are, per the interfaces in `shot-sensors.ts`: a11y `tags`, `disableRules`, `exclude`;
diff `threshold`, `minPixels`, `mask` (selectors painted over, a clock or a carousel), `freezeTime`; cls
`minTotal`; text `patterns`, `ignore`, `i18nKeys`; html `preset`, `rules`, `raw`. Nothing else exists there.
Ask before switching a sensor off. Data that follows the real date (a calendar, "today") is a `mask`
candidate; `freezeTime` does not help when the server picks the data. Changing `mask` later invalidates the
diff baselines: the next shot of every name and viewport you compare takes `--reset-diff` once. Verify: a shot prints all five sensor lines without
`<label> error:`.

### 2d. Optional blocks, each behind one question

| Block | Ask | Skip when | How to skip | Verify when kept |
|---|---|---|---|---|
| `flows.ts`, `seed.ts` | "Should agents be able to create test data through the UI (registration, first record)?" | the app has no registration, or the test users already carry enough data | delete `seed.ts` and its `seed` script in `package.json`; `flows.ts` keeps one real step the specs or exploratory agents will use (opening the first record, say), or none, and loses its marker | `npm run seed --prefix e2e -- --count=1` ends with `to look at a route as a seeded account:` and an `E2E_USER=… npm run shot …` line, and a shot as that user says `assumes held` |
| `test-accounts.ts`, `global-setup.ts`, `global-teardown.ts` | "Is there an endpoint that resets a test account, or should one be built?" | no reset exists and none is wanted, or the app has no accounts | `TEST_ACCOUNTS = []` (already so with `NO_LOGIN`), drop the endpoint code, keep the no-op that says so once, delete both markers | `npm run test --prefix e2e` runs the suite without a setup error |
| coverage: backend part of `project.ts`, `backend-coverage.ts` | "Do you want to know which changed lines no e2e flow executes?" Backend part only for a JVM backend with Maven | coverage is not wanted (the frontend part has nothing to skip) | tell the human the Maven profile is not added and delete the marker in `backend-coverage.ts`; `BACKEND_DIR` stays, a missing `pom.xml` switches the part off by itself | `npm run test:coverage --prefix e2e` (says "frontend only" without an agent), then `npm run coverage:gaps --prefix e2e -- --base <ref>` lists the changed files with gaps as line ranges and ends with `N of M changed executable lines are not run by any e2e test (P % covered)`; with nothing changed `0 of 0 … (100 % covered)`. A branch with no common history with the default ref needs `--base` |

A skip condition that is readable from the repo (no registration, no accounts) needs no question; say what
you skipped and why. An empty `flows.ts` (header and `STEP_TIMEOUT` only) is fine: the specs and the
exploratory agents import from it once they have a form to drive. **Never run `test:coverage` before the
JaCoCo port in `project.ts` is settled and `doctor` shows it as this project's:** the run resets whatever
agent answers there, and the harness's identity check (a non-destructive dump searched for this backend's
class names) is the last line of defence, not the first.

Skipping a block means removing its traces, not only its markers: `grep -rn seed e2e --exclude-dir=node_modules`
(or the block's name) finds the header comments and the `e2e/AGENTS.md` rows that still describe it; reword
them. `flows.ts` keeps its rules whatever goes in: `import type` only from `@playwright/test`, waits via
`locator.waitFor()`, assertions stay in the specs. `seed.ts` keeps its refusal to run against a non-local server.

## 3. Install the skills

Copy `skills/look-at-page` and `skills/exploratory-testing` into the project's skill directory. `ls -la
.claude/skills .agents/skills` shows the project's convention: real directories in one of them and symlinks
in the other, or one of the two alone. Follow it; when there is none, or it is mixed (some skills linked,
some copied twice), use `.agents/skills/<name>/` as the cross-tool location and symlink
`.claude/skills/<name>` to it for Claude Code. A new skill is read at the
start of the next session, not in this one.

Then work the markers of `exploratory-testing` (`doctor` lists them): the language the fragments are written
in, where the project keeps test protocols, how it lists open issues, and its cleanup for `EXPL-*` records
(or, when records cannot be named, the reset the project offers instead and who may run it). Each answer comes
from the human or the repo, never from a guess; a placeholder you cannot fill stays a marker and is reported
in step 5. `look-at-page` carries no markers: its login, seeding and `--port` passages are written for both
kinds of app. One edit is still due without a login or without `seed.ts`: strike the words that no
longer apply from its `description` line (the trigger text), so the skill does not fire on "seed local
data" in a project that cannot seed.

## 4. The root agent file

Copy `docs/browser-testing.md` from harness-blocks to the project's `docs/`: the snippet and the
`look-at-page` skill point at that path. Then paste `docs/agents-md-snippet.md` into the root `AGENTS.md` or
`CLAUDE.md`, whichever the project keeps; both, if both exist and are not linked. When neither exists, create
`AGENTS.md` and a `CLAUDE.md` holding the single line `@AGENTS.md` (Claude Code imports it). Fill the *Dev
server* section (URL, who starts it, what a backend restart does to the data), strike the login and
seeding words from *Looking at the UI* where they do not apply, and fill the *Test users* table:
every local account an agent may log in as, what it carries, which routes it reaches, where the password is;
without a login, the one row the snippet shows for that case. The skills point at that section by its heading,
so keep the heading `Test users`. Passwords of local-only throwaway users may be written there; anything else
is a pointer to where they live.

Verify: `npm run doctor --prefix e2e` reports the section, and the table has at least one row without angle
brackets.

## 5. Final check

All of these, in one go (`BASE_URL=<url>` in front where this machine differs; `E2E_USER` / `E2E_PASSWORD`
only with a login):

```bash
npm run doctor --prefix e2e                                                       # no ✗, "no ADAPT markers left"
npm run typecheck --prefix e2e                                                    # exit 0
npm run shot:selftest --prefix e2e                                                # exit 0, last line "N/N passed", no ✗
npm run shot --prefix e2e -- /<route>                                             # assumes held; session cached, or none without a login
npm run shot --prefix e2e -- /<route> --viewport=mobile                           # assumes held; read the overflow line
npm run test --prefix e2e                                                         # smoke.spec.ts passed (its login test skipped without a login)
```

What the shots find about the app (an overflow at 375px, an unlabeled button) is a finding for the human, not
a blocker for the adoption and not yours to fix. A marker you could not resolve is reported to the human with
the question it needs, not deleted.

## 6. Commit, and decide the fate of this skill

Commit everything the adoption created or changed: `e2e/`, the skills, `docs/browser-testing.md`, the agent
file(s), the root `.gitignore`, and whatever an optional block added (a protocols directory). `git status`
must show nothing under `e2e/.auth/` or `tmp/`. Then delete `adopt-harness` from the project's skill directory
if it was installed there: it fires on "set up the harness" and on remaining markers, and once the list is
empty its description only costs context on every turn. Keep it only if the project intends to pull later
harness-blocks releases and re-run the adoption on the diff; say which in the commit body.
