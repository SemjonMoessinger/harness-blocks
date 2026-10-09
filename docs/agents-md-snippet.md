# Snippet for the root `AGENTS.md` / `CLAUDE.md`

Paste the block below into the adopter's root agent file and fill the *Dev server* section and the *Test
users* table. The skills point at both sections by name, so keep the headings `Dev server` and `Test users`.
When the project has neither `AGENTS.md` nor `CLAUDE.md`, create `AGENTS.md` and a `CLAUDE.md` holding the
single line `@AGENTS.md`.

---

## Dev server

The frontend dev server answers on `<http://localhost:4200>` (`DEFAULT_BASE_URL` in `e2e/project.ts`); on a
machine where that port is taken, run the harness with `BASE_URL=<url>` in front of the command. `<Who
starts the servers, and what agents may do: start none, restart none; a server that was already up belongs
to someone else.>` `<What a backend restart does to local data, e.g. rebuilds the demo database.>`

## Looking at the UI

To see a rendered route, `<seed local data,>` or check for console errors, horizontal overflow, a11y
violations and layout shifts, use the `look-at-page` skill. It wraps the e2e screenshot harness
(`npm run shot --prefix e2e -- /route`)`<, and caches the login, so routes behind the login are exactly
what it is for>`. Subagents without a Skill tool read it at `.claude/skills/look-at-page/SKILL.md`.
(The two bracketed parts apply only to a project with seeding, respectively with a login.)

Which browser surface to drive beyond that (Playwright script, Playwright MCP, a browser extension, raw
CDP) and the security reasoning: `docs/browser-testing.md`. To get **oriented** in this repo's own UI,
read the templates and routes first. Playwright MCP only where there is no source to read (staging, an
external site, a third-party page) or to walk one finding step by step, in a fresh subagent; a Playwright
script to **probe** or measure (failures, widths, double submits), even the first time. Rule of thumb: code
to orient, MCP where there is no code, script to repeat.

To hunt for defects on a route before handing it to users: the `exploratory-testing` skill, in a fresh
session. Its agents report and never fix.

## Test users

Local-only accounts; the data each one carries decides which routes render for it.

| `E2E_USER` | Password | Carries | Reaches |
|---|---|---|---|
| `<username>` | `<where to find it>` | `<role, data>` | `<routes>` |

For an app without a login, the table has this one row instead:

| `E2E_USER` | Password | Carries | Reaches |
|---|---|---|---|
| — | — | no login; every shot is anonymous, data comes from `<where>` | all routes |

## E2e coverage

To learn whether any e2e flow runs the code you changed: `npm run test:coverage --prefix e2e`, then
`npm run coverage:gaps --prefix e2e` (add `-- --base <ref>` on a branch that shares no history with the
default ref). It lists the changed lines no flow executes. An uncovered line is the signal worth acting on;
a covered one only means some flow ran it, not that an assertion checked it. Close a gap with a test of the
behaviour behind it.

## Scratch files

Throwaway scripts go in `e2e/tmp/` (gitignored, the only place that can import `playwright`) and run from
the repository root with `node e2e/tmp/<name>.ts`; PNGs go to `<repo>/tmp/shots/`. After any change under `e2e/`:
`npm run typecheck --prefix e2e`.
