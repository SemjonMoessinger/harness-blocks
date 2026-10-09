# harness-blocks

Combinable building blocks of the outer harness around a coding agent. The first set covers frontend QA:
a screenshot harness the agent runs while implementing, an exploratory-testing skill for a separate
session, e2e coverage that tells the agent which changed lines no flow executed, and a skill that adapts
all of it to your codebase one verified step at a time.

The repository accompanies a magazine article on agentic frontend QA. Everything here was lifted from a
real Angular/Spring Boot project and stripped of that project. An application with a login and one without
are both first-class cases (`NO_LOGIN` in `e2e/login.ts`). Further blocks (other harness components, first
steps towards a software factory) will land next to these.

## For humans

**The four steps the blocks support**

1. **Visual check while implementing.** The agent renders a route with `shot.ts` and reads a compact
   report: where it landed, console errors, overflow, a11y violations, layout shifts, text leaks, invalid
   HTML. It opens the PNG only when a visual judgement is needed.
2. **Exploratory testing by agents.** The `exploratory-testing` skill runs one sub-agent per dimension
   (input limits, async, keyboard, layout, saving and error paths, ...) in a fresh session. They report
   and never fix.
3. **Human review.** You confirm and prioritise the findings and add what only a human sees.
4. **Regression tests.** Selected cases become Playwright specs; `coverage:gaps` shows the changed lines
   no spec runs.

**What is in here**

| Path | Block |
|---|---|
| `e2e/` | the harness: `project.ts` (the project profile), `login.ts` (the login), `doctor.ts` (environment and adoption check), `shot.ts` and its sensors, `seed.ts`, account reset, coverage tooling, an example spec; `e2e/AGENTS.md` explains the mechanics |
| `skills/adopt-harness/` | the step-by-step adoption skill; start here |
| `skills/look-at-page/`, `skills/exploratory-testing/` | the two day-to-day skills, installed into your repo by the adoption skill |
| `docs/browser-testing.md` | which browser surface an agent should drive, and why: "code to orient, MCP where there is no code, script to repeat" |
| `docs/agents-md-snippet.md` | the block to paste into your root `AGENTS.md` / `CLAUDE.md` |
| `integrations/` | templates: a GitHub Actions workflow for the suite, a Claude Code permission allowlist, a Playwright MCP server entry |

**Getting started** takes a running dev server, one test user with enough data, Node 23.6 or newer and
Chromium for Playwright (`npx playwright install chromium`).

1. Copy `e2e/` (without `node_modules/` and `.auth/`) to your repository root and `skills/adopt-harness/`
   into your agent's skill directory (`.claude/skills/` for Claude Code, `.agents/skills/` as the cross-tool
   location).
2. Start a **new** session (skills are read at session start) and say: *adopt the harness*. The skill
   installs the untouched harness, proves it green, then works through every `ADAPT:` marker with you, login
   first, verifying each step with a real screenshot before moving on. `npm run doctor --prefix e2e` shows
   the state at any time.
3. Without a skill-capable agent, paste the prompt at the end of this file instead.

At run time nothing here talks to a network beyond your own dev server; `shot.ts` aborts requests to any
other host and reports them as `blocked`. Sessions are cached under `e2e/.auth/` and screenshots under
`tmp/shots/`; the shipped `e2e/.gitignore` covers the first, `tmp/` in your root `.gitignore` the second. MIT licensed, see `LICENSE`.

## For agents

Read this section when you are adapting harness-blocks to a repository or changing the blocks themselves.
The day-to-day use of the harness is in `skills/look-at-page/SKILL.md`; the mechanics in `e2e/AGENTS.md`.

**The contract**

- `e2e/` sits at the repository root and is driven as `npm run <script> --prefix e2e -- <args>`. Scripts
  run under plain `node`, which strips types without checking them, so `npm run typecheck --prefix e2e`
  is the only type check and runs after every change.
- `project.ts` is the project profile: the dev server's canonical URL (`BASE_URL` overrides it per
  machine), its start command, allowed hosts, redirecting routes and guard pages, the UI framework's class
  prefixes, source directories, the Maven backend and its JaCoCo port. Nothing else in `e2e/` states a
  project fact.
- `login.ts` is the only file that knows how the application authenticates. It exports `NO_LOGIN`,
  `TestUser`, `DEFAULT_USER`, `login(page, user)`, `isLoggedIn(page)` and `sessionSlug(user)`. Everything
  else imports auth from there and nowhere else. With `NO_LOGIN` every shot is anonymous and the login
  parts of the harness switch themselves off. The login runs at desktop width; `isLoggedIn` waits for a
  rendered marker and never samples a point in time.
- Every place an adopter must change is a comment that begins exactly `ADAPT:` and continues with one
  sentence. `npm run doctor --prefix e2e` is the to-do list and the progress bar: it lists the markers left
  and checks the environment around them; a resolved marker is deleted. The skills carry their own markers
  as HTML comments.
- `shot.ts` reports, it does not judge: an `assumes NOT held` line means a guard redirected away from the
  requested route and the PNG shows that other page. Sensors never fail a run; the exit code only says
  whether the shot itself worked. `shot.config.ts` belongs to the human and can only be narrowed by flags.
- Outputs: `<repo>/tmp/shots/` for PNGs, `e2e/.auth/state-<slug>.json` for cached sessions,
  `e2e/tmp/` for throwaway scripts (the only place that can import `playwright`), `e2e/coverage/` for
  reports. All gitignored.
- Rule of thumb for browser access: read the code to orient, MCP only where there is no code to read, a
  script for anything repeated more than twice. Reasoning and the prompt-injection angle: `docs/browser-testing.md`.
- Exploring agents report and never fix. That separation is the point of step 2.

**Adopting**

Follow `skills/adopt-harness/SKILL.md`. Its order is not negotiable: install untouched and prove green,
then `login.ts` (one shot without a login, three with one: `--anon`, `session fresh`, `session cached`),
then `project.ts`, then the sensor config, then the optional blocks each behind one question to the human,
then the skills and the root agent file, then the final check. Ask the two shaping questions, login and URL,
first and in one message. Never guess credentials, never widen an identity provider's redirect list or a
CORS list on your own, never kill a server you did not start, never shoot a port you have not confirmed
serves this app.

**Changing the blocks**

- Run `npm run typecheck --prefix e2e`, `npm run lint --prefix e2e` and `npm run shot:selftest --prefix e2e`
  after touching anything under `e2e/`. The self-test proves each sensor fires on a broken fixture and
  stays quiet on `shot-fixtures/clean.html`; a false positive there is fixed in the sensor, never by
  making the fixture worse.
- Project names, hostnames, credentials and domain vocabulary of any origin project do not belong in this
  repository. Examples use `/dashboard`, `/settings`, a `Project` entity and `example.com`.
- A new block gets its own directory at the root, an entry in the table above, and an `ADAPT:` list that
  is complete on its own.

**Prompt for agents without skill support**

```text
Read README.md of harness-blocks, section "For agents", then skills/adopt-harness/SKILL.md in full.
Adopt the harness into this repository exactly in the order that skill prescribes. Install the untouched
e2e/ directory first (without node_modules and .auth) and prove typecheck, shot:selftest and
`npm run doctor --prefix e2e` green. Then work the markers doctor lists, login.ts first, then project.ts,
verifying each checkpoint with the commands the skill names before deleting a marker. Ask me for every
credential, URL or decision you cannot read from the repository, the login and the URL first and all
questions in one message. Do not install adopt-harness itself into the repository. Stop and report when a
marker cannot be resolved.
```
