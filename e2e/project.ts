/**
 * The project profile: every fact about this project that the harness needs, in one file.
 * shot.ts, seed.ts, playwright.config.ts and the coverage tooling read it from here and define
 * nothing project-specific themselves. Adopting the harness means working the ADAPT markers in
 * this file and in login.ts (the login itself), then deciding the optional blocks;
 * `npm run doctor` lists what is left and checks the environment.
 *
 * Plain node runs this file, and coverage-gaps.ts loads it without the TypeScript compiler or
 * monocart, so it stays free of dependencies.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// --- Where the app is ---------------------------------------------------------------------------

/** Paths in reports are shown relative to the repository root, e2e/'s parent. */
export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// ADAPT: the URL the frontend dev server answers on in this project (its canonical port, as the README names it). A machine where that port is taken passes BASE_URL on the command line instead; never bake a per-machine port in here.
export const DEFAULT_BASE_URL = 'http://localhost:4200';

/** The one address every script and the suite depend on. */
export const BASE_URL = process.env.BASE_URL ?? DEFAULT_BASE_URL;

// ADAPT: the command that starts the frontend dev server (shown in error hints), and the same on another port (for --port).
export const FRONTEND_DEV_SERVER_COMMAND = 'cd frontend && npm start';
export function frontendDevServerOnPort(port: string): string {
  return `cd frontend && npm start -- --port ${port}`;
}

/** Whether `url` points at this machine. seed.ts refuses anything else; coverage ignores a local agent for a remote run. */
export function isLocal(url: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
}

// --- What shot.ts needs to know about the routes ------------------------------------------------

/**
 * Hosts a page may load from; a request to any other host is aborted and reported as `blocked`.
 * A sandboxed agent's firewall typically DROPs a blocked host rather than refusing it, so one
 * remote asset can hang the whole page load. Aborting keeps shots deterministic and makes
 * third-party creep visible.
 */
// ADAPT: add every host the app legitimately loads from at development time (a CDN, a tile server, an embedded widget), or keep the list local and let the `blocked` line show what the app reaches for.
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Routes whose whole job is to redirect: landing elsewhere from one of these is the app working. */
// ADAPT: list the routes that send any visitor elsewhere (a home page that distributes by account state, an /app entry point).
export const REDIRECTING_ROUTES: ReadonlySet<string> = new Set(['/']);

/**
 * Where the guards send an authenticated visitor whose account is not far enough along, and what
 * that says about them. Anything else a guard redirects to means the login simply is not the one
 * the route was built for.
 */
// ADAPT: map each onboarding or guard page to what landing there says about the account; `{}` when the app has no guards.
export const GUARD_TARGETS: Readonly<Record<string, string>> = {
  '/onboarding': 'has not completed onboarding',
};

/**
 * Classes of the UI framework, which name a component rather than the app's element: header and
 * footer are both `mat-toolbar.mat-toolbar`, only the footer is `app-footer` as well. A class that
 * does not match is taken as the app's own and wins in every finding.
 */
// ADAPT: the class prefixes of this project's UI framework (Angular Material below); utility-class frameworks such as Tailwind or daisyUI need no change, their first class already names the element.
export const UI_FRAMEWORK_CLASS_PATTERN = /^(mat|mdc|cdk|ng)-|^notranslate$|^material-(icons|symbols)/;

// --- Frontend coverage --------------------------------------------------------------------------

// ADAPT: the repo-relative directory of the frontend's own sources, with a trailing slash.
export const FRONTEND_SOURCE_DIR = 'frontend/src/';

export const FRONTEND_REPORT_DIR = fileURLToPath(new URL('./coverage/frontend/', import.meta.url));
export const FRONTEND_LCOV = `${FRONTEND_REPORT_DIR}lcov.info`;

/**
 * The file kinds of the frontend's own sources, as the dev server serves them: Angular's dev server
 * bundles everything into `.js` chunks, so `.ts` names only the sources; a Vite app imports its
 * modules by their own name (`/src/main.tsx`, `/src/App.vue`), so each such extension has to be
 * listed or coverage.ts never sees the module. Drives isFrontendSource, which scripts coverage.ts
 * collects, and which files its report lists even when no spec loaded them.
 */
// ADAPT: the extensions of the frontend's own sources ('.ts' for Angular; add '.tsx', '.jsx', '.vue' or '.svelte' for a Vite app that imports modules by those names).
export const FRONTEND_SOURCE_EXTENSIONS: readonly string[] = ['.ts'];

/**
 * The frontend's own sources: files with one of FRONTEND_SOURCE_EXTENSIONS under
 * FRONTEND_SOURCE_DIR minus specs and per-stage environment files (which only replace
 * environment.ts in builds other than the dev server's). Templates are out too: their source-map
 * lines point into compiled render functions.
 */
export function isFrontendSource(path: string): boolean {
  return (
    path.startsWith(FRONTEND_SOURCE_DIR) &&
    FRONTEND_SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) &&
    !/\.(spec|test)\.[^./]+$/.test(path) &&
    !/\/environments\/environment\.[^/]+\.ts$/.test(path)
  );
}

// ADAPT: the branch the team merges into, on its main remote (`git remote -v`): the ref `coverage:gaps` diffs against by default. A branch that shares no history with it passes `--base <ref>` per call rather than changing this.
export const DEFAULT_BASE_REF = 'origin/main';

// --- Backend coverage (optional, JVM + Maven) ---------------------------------------------------
// Without a pom.xml at BACKEND_DIR the backend part switches itself off and every run measures
// the frontend alone; nothing below needs to change then.

// ADAPT: the backend's Maven project (the directory with pom.xml and mvnw); leave it if there is none.
export const BACKEND_DIR = fileURLToPath(new URL('../backend/', import.meta.url));

/** Whether there is a Maven backend to measure at all. */
export const BACKEND_PRESENT = existsSync(`${BACKEND_DIR}pom.xml`);

/** The Maven profile that attaches the JaCoCo agent; its template is in backend-coverage.ts. */
export const BACKEND_MAVEN_PROFILE = 'e2e-coverage';

/** Shown when no agent answers. */
export const BACKEND_START_COMMAND = `cd backend && ./mvnw -P${BACKEND_MAVEN_PROFILE} jacoco:prepare-agent spring-boot:run`;

// ADAPT: the JaCoCo agent's TCP port. It must equal the <port> of the Maven profile, and it must be one no other project on this machine uses: a coverage run resets and dumps whatever agent answers on it (`lsof -iTCP:6300 -sTCP:LISTEN` shows who does).
export const JACOCO_AGENT_PORT = 6300;

/** src/main/kotlin/ and/or src/main/java/, whichever the backend has, repo-relative. */
export const BACKEND_SOURCE_ROOTS: readonly string[] = ['kotlin', 'java']
  .map((language) => `${BACKEND_DIR.slice(REPO_ROOT.length)}src/main/${language}/`)
  .filter((root) => existsSync(`${REPO_ROOT}${root}`));

export function isBackendSource(path: string): boolean {
  return BACKEND_SOURCE_ROOTS.some((root) => path.startsWith(root)) && /\.(kt|java)$/.test(path);
}

/** Must match the jacoco-maven-plugin's outputDirectory in the profile. */
export const BACKEND_REPORT_DIR = `${BACKEND_DIR}target/site/jacoco-e2e/`;
export const BACKEND_JACOCO_XML = `${BACKEND_REPORT_DIR}jacoco.xml`;
/**
 * Class names whose execution data did not match target/classes at report time, one per line.
 * Written by backend-coverage.ts, read by coverage-gaps.ts.
 */
export const BACKEND_MISMATCH_FILE = `${BACKEND_REPORT_DIR}class-mismatch.txt`;
