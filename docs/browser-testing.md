# Browser testing: which surface an agent should drive

Two axes decide everything here:

1. **Whose profile the browser uses**: an empty throwaway one, or your real browser with every live login
   in it. This is the security axis.
2. **How observations reach the agent**: as tool calls (every screenshot and page read enters context) or
   as the stdout of a script the agent wrote (only the distilled result enters context). This is the cost
   axis.

Every option below is a point in that space. All of them answer the same question: *how do I look at a
page*.

| | Browser | Profile | Who filters | Token cost per look |
|---|---|---|---|---|
| **Browser extension** (the agent drives your real browser) | your real browser | **your live logins** | **the model**: raw page enters context | **high**: a screenshot costs ≈ width × height / 750, a page dump scales with the DOM |
| **CDP on a debug port** | a browser you launched yourself | whatever you point it at | **the script**, in-browser; only stdout crosses | **low**, flat |
| **Playwright script** | browser Playwright launches | isolated, empty | **the script**, in-browser; only stdout crosses | **low**, flat |
| **Playwright MCP** | browser Playwright launches | own persistent profile per workspace; `--isolated` for an empty one | **the model**, on an accessibility tree; or the page via `browser_evaluate`, then like a script | **low to medium**: a full snapshot 1–10k, a targeted one a few hundred |

An IDE's or desktop app's built-in browser pane, where one exists, behaves like the extension row for cost
(the model filters) and like the script row for security (isolated profile).

The column that actually matters is **flat vs. linear**: with the extension and MCP every additional element
you inspect costs another read, so ten checks cost ten times one. With a script the filtering happens inside
the browser and only the answer is printed, so ten checks and a thousand cost the same handful of tokens.
That advantage disappears the moment a script dumps raw HTML instead of a verdict.

## Pixels, accessibility tree, or a verdict

**An accessibility tree** is what the browser derives from DOM + ARIA and hands to screen readers: per node a
role, a name, a state and the hierarchy. A hundred DOM nodes of a component-library dialog become five lines
of tree, and the `[ref_N]` handles in an MCP snapshot are steadier click targets than CSS selectors against
generated class names. **What it does not contain is any appearance**: no colors, sizes, positions, fonts. A
button that is white-on-white, hidden behind the footer, or pushed off a 375px viewport looks perfectly
healthy in an accessibility tree. Use it for "is the control there, named right, in the right state", never
for "does it look broken".

**Every surface can take screenshots.** The axis is not whether an image can be produced but **whether it
lands in context automatically or on disk**. With the extension every screenshot costs its tokens whether or
not it turns out informative. With a script the PNG is a file, and the agent opens it only when a visual
judgement is actually needed: twelve shots plus all measurements for a few hundred tokens, then the two PNGs
the script flagged. Screenshot on demand, not on sight.

Contrast ratios, overflow and touch-target sizes are **measurements, not sights**. Reading the computed value
beats estimating it from an image. Reserve screenshots for "does this hang together", the one question a
number cannot answer.

## Security: it is the profile, not the surface

**The extension is the only option that forces your real profile.** That is what makes it riskier, not
sloppier tooling:

- **Ambient authority.** Your browser holds live sessions for your code host, mail, cloud console. The agent
  needs no credentials there; it already is you.
- **Injection needs a weapon, not just a voice.** Every page read is untrusted input. Injection alone is
  harmless; injection *plus* capability is not. "Go to the code host and delete the repo" hits a login wall
  on an empty profile and succeeds on yours.
- **Side effects are real.** A click sends an actual message, a submit posts as you. A throwaway profile is
  disposable; your browser is not.

**Your own dev environment is an injection vector.** A publicly reachable dev or staging server carries
whatever text anyone has typed into it: a profile description, a comment, a record name. That text lands in
the model's context the moment an agent reads the page through MCP or the extension. It is content, not
instruction, but the model has to be told so every time, and the surface with the live profile is the one
where a successful injection has something to act with. Prefer the local stack for agent runs; treat every
page from a shared environment as untrusted.

**CDP is conditionally safe**, and the condition is the throwaway profile: a debug port has no auth, so any
local process (an npm postinstall script, say) can drive the browser behind it. Never point it at your daily
profile; always `--user-data-dir=/tmp/<throwaway>`. A Playwright script avoids the problem entirely by
never opening a port.

**Permission deny rules do not cover browser tools.** A rule written for the file-read tool matches that tool
only; navigating to `file:///…/.env` and reading the page text is a different tool. This applies to the
extension, MCP and a built-in pane alike. Scripts route through the shell, which is permission-gated at the
command level, but a script can still read anything Node can.

**Never combine the extension with a skip-all-permissions mode.** The per-action confirmations are the main
thing making it tolerable.

## When to use which

The first question is not which surface but **how many times you will run it**. A one-off look does not
justify writing a file; a loop you will run ten times does, because you write it once and re-run it for free.

| Task | Use | Why |
|---|---|---|
| One-off look: "I nudged the padding, check it" | `shot.ts` (below), else MCP | one command, nothing to write |
| Getting **oriented** in your own UI: an unfamiliar route or flow | the templates and routes first, then a script | selectors and paths are in the source; discovering them in a browser costs a model turn per click |
| Getting **oriented** where there is no source to read (staging, an external site, a third-party page), or walking one bug report step by step | MCP, in a fresh subagent | each observation shapes the next action, so it has to enter context |
| **Probing** systematically: a known question across states, failures, widths, double submit, races | script, one agent per dimension (`exploratory-testing` skill) | even the first time: agents run in parallel, `page.route` injects the failure, and one run checks dozens of states |
| **Iterating on a UI change**: edit, look, adjust, repeat | `shot.ts` | login and navigation are paid once, not per iteration |
| Bulk or quantitative measurement, performance traces | script (or CDP) | 50 measurements cost the same context as 1; MCP cannot produce a trace file |
| Your own session on a remote site, skipping re-auth | extension, scoped to one origin, reluctantly | the only thing no other surface does |
| Regression coverage that must survive | `e2e/tests/` + the Playwright runner | CI is the authority |

Rule of thumb: **code to orient, MCP where there is no code, script to repeat.** An agent working on its own
repo can read the component templates and the router before any page loads, so orienting in a browser pays
off only where the source cannot answer. Even when MCP is prescribed, an agent that already knows its next
steps drifts back to code and sends scripts through `browser_run_code_unsafe`. Anything the agent needs more
than two or three times in the same form (login, desktop and mobile shots, console errors) belongs in a
script. Both chain: orient from the code (or by MCP where there is none), turn the known path into a script,
and after human review into a durable spec.

The cost of MCP is set less by the size of one snapshot than by the context every turn re-reads: an MCP run
inside a long main session re-reads that whole session per click. Run it in a fresh subagent. All subagents
of one session share the one MCP browser, so MCP does not parallelise; scripts do.

## The screenshot harness: `e2e/shot.ts`

The naive version of the dev loop re-drives the login on every pass: as MCP tool calls that is five to
fifteen round trips before the page under test is even on screen, repeated every iteration. As a script it
runs once and caches. `e2e/shot.ts` is that script. It renders one route of the running dev server, writes a
PNG, and prints a compact report:

```bash
npm run shot --prefix e2e -- /account/overview
```

```
route      /account/overview
landed     http://localhost:4200/account/overview
assumes    held — <user> reached the route asked for
session    cached
viewport   1280x800
shot       tmp/shots/account-overview.png
console    1 error(s)
             Failed to load resource: the server responded with a status of 404 ()
network    1 failed
             404 GET http://localhost:8080/api/account
blocked    none
overflow   none
a11y       2 rule(s), 2 node(s); 0 incomplete
             critical button-name ×1  .menu-toggle
             serious color-contrast ×1  .header-cta > .btn-label
diff       baseline created
cls        0.02 (sum), 2 shift(s)
text       clean
html       clean (dom)
```

The first run logs in; every later run restores the session. `landed` is the URL actually reached, which is
how a silent redirect back to the login shows up instead of hiding. `assumes` is the same idea one level up:
a guard that bounced the shot to another page is reported as a failed assumption, with the remedy that fits
the login, instead of a PNG of the wrong page under the right name.

Flags, sensors, seeding and the second-dev-server case (`--port`, only when an identity provider or a
CORS list pins the browser's origin; otherwise `BASE_URL` does the job): `look-at-page` skill.

Divide the judging: the **script measures** what is measurable, the **agent looks** for gross breakage
(overlap, clipped text, elements outside the viewport, obviously wrong colors), and a **human judges
aesthetics**, on the final result, not on every iteration.

To avoid a permission prompt on every iteration, allowlist the command in the agent tool's settings, e.g.
`Bash(npm run shot --prefix e2e:*)`. Prefer `--prefix e2e` over `cd e2e && …`: a compound `cd` re-prompts
even when the command itself is allowed.

## Playwright MCP notes

```bash
claude mcp add playwright -- npx -y @playwright/mcp@latest
```

It has nothing to do with a browser extension: separate process, separate browser, no per-tab grant. By
default it launches the installed Chrome on its own **persistent** profile, one per workspace; a second
session in the same repo fails with `Browser is already in use`, hence `--isolated`. Flags move between
releases; verify with `npx @playwright/mcp@latest --help`. Never point `--user-data-dir` at your daily
profile; that recreates the extension's risk without its grant dialog.

## Playwright Test Agents: the other question

`npx playwright init-agents --loop=<tool>` installs three agent definitions shipped by Playwright (planner,
generator, healer). They answer a different question: the surfaces above produce an observation, these
produce a file in `e2e/tests/`, with locators recorded from real actions instead of guessed. Two hazards:

- **The healer is allowed to disable your tests.** Its definition ends with: if the error persists and it
  is confident the test is correct, mark it `test.fixme()`. Run it on a clean tree and read the diff. Every
  new `test.fixme()` is a bug report the agent filed against the app and then silenced.
- **The definitions are a snapshot, not a link.** They freeze a tool list and a model; re-run `init-agents`
  as part of every Playwright bump, and re-read the diff.

## Playwright notes

- `baseURL` in `playwright.config.ts` is the suite's only dependency, so a spec also runs against the local
  stack; one that passes only thanks to local data fails in a CI stack that starts empty.
- Login belongs in a cached `storageState`, not inline per spec; `shot.ts` makes the same trade.
- Ad-hoc scripts are throwaway (`e2e/tmp/`). Anything worth keeping becomes a spec in `e2e/tests/`, where
  the runner is the authority.
