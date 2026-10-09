/**
 * Which backend code an e2e run executes, from the JaCoCo agent of a JVM backend started with the
 * coverage Maven profile (BACKEND_MAVEN_PROFILE and BACKEND_START_COMMAND in project.ts).
 * Optional: without a JVM backend, or without the agent, every run measures the frontend alone
 * and says so.
 *
 * The agent keeps its counters in the running JVM and hands them out over TCP on
 * localhost:JACOCO_AGENT_PORT, so a running backend can be measured without a restart. The run
 * zeroes them once the project's global setup has run (e.g. a test-data reset), which drops
 * whatever the backend executed before, its own startup included, and fetches them before the
 * project's global teardown runs. Code that only runs at startup (configuration, dependency
 * wiring) therefore shows as uncovered, and the harness's own data resets do not count.
 *
 * Anything short of a local backend with a working agent is not an error: the run then reports
 * the frontend alone and says why.
 *
 * The profile, for the backend's pom.xml. The agent is attached through prepare-agent on the
 * command line rather than bound to a phase: bound to a phase, it would run in spring-boot:run's
 * forked lifecycle, whose jacocoAgent property the run goal never sees. Output tcpserver instead
 * of writing the counters at JVM exit is what allows measuring a running backend. The exec file
 * is named through the `jacoco.destFile` property rather than literally: a value written straight
 * into <configuration> wins over any -D on the command line, and the identity probe below relies
 * on redirecting one dump with -Djacoco.destFile.
 *
 *   <profile>
 *     <id>e2e-coverage</id>
 *     <properties>
 *       <jacoco.destFile>${project.build.directory}/jacoco-e2e.exec</jacoco.destFile>
 *     </properties>
 *     <build>
 *       <plugins>
 *         <plugin>
 *           <groupId>org.jacoco</groupId>
 *           <artifactId>jacoco-maven-plugin</artifactId>
 *           <version>0.8.15</version>
 *           <configuration>
 *             <propertyName>jacocoAgent</propertyName>
 *             <output>tcpserver</output>
 *             <address>localhost</address>
 *             <port>6300</port>
 *             <includes><include>com/example/**</include></includes>
 *             <destFile>${jacoco.destFile}</destFile>
 *             <dataFile>${jacoco.destFile}</dataFile>
 *             <outputDirectory>${project.reporting.outputDirectory}/jacoco-e2e</outputDirectory>
 *           </configuration>
 *         </plugin>
 *         <plugin>
 *           <groupId>org.springframework.boot</groupId>
 *           <artifactId>spring-boot-maven-plugin</artifactId>
 *           <configuration><jvmArguments>${jacocoAgent}</jvmArguments></configuration>
 *         </plugin>
 *       </plugins>
 *     </build>
 *   </profile>
 *
 * ADAPT: add this profile to the backend's pom.xml (ask first; it is a product file) with the base package in <includes> and the JACOCO_AGENT_PORT of project.ts in <port>, keeping destFile and dataFile as the ${jacoco.destFile} property; if the backend is not started through spring-boot:run, pass ${jacocoAgent} to its JVM your own way.
 */

import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BACKEND_DIR,
  BACKEND_MAVEN_PROFILE,
  BACKEND_MISMATCH_FILE,
  BACKEND_REPORT_DIR,
  BACKEND_START_COMMAND,
  JACOCO_AGENT_PORT,
  BACKEND_PRESENT,
  isLocal,
} from './project.ts';

/**
 * Setup and teardown run in the same runner process. Without a successful reset, a dump would
 * report everything the backend executed since it started.
 */
const RESET_MARKER = 'E2E_BACKEND_COVERAGE_RESET';

/** Whether something accepts a TCP connection on localhost:`port` within `timeout` ms. doctor.ts uses it too. */
export function portAnswers(port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: 'localhost', port, timeout });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Returns Maven's output. Its own JVM warnings land on stderr on every call, so that is shown only on failure. */
function maven(...args: string[]): string {
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? 'mvnw.cmd' : './mvnw', [`-P${BACKEND_MAVEN_PROFILE}`, ...args], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    shell: windows,
  });
  if (result.error) throw new Error(`mvnw in ${BACKEND_DIR} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`mvnw ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

function frontendOnly(reason: string): void {
  console.log(`Backend coverage skipped, this run measures the frontend only: ${reason}`);
}

/** Up to `limit` class names under target/classes, in JaCoCo's slash form (`com/example/Foo`). */
function compiledClassNames(dir: string, limit: number, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (found.length >= limit) break;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) compiledClassNames(path, limit, found);
    else if (entry.name.endsWith('.class') && !entry.name.includes('$')) {
      found.push(relative(`${BACKEND_DIR}target/classes`, path).replace(/\.class$/, '').replaceAll('\\', '/'));
    }
  }
  return found;
}

/**
 * Whether the agent on JACOCO_AGENT_PORT belongs to this backend. Two projects on one machine both
 * using JaCoCo's default port would otherwise reset and dump each other's counters, silently. A
 * non-destructive dump is taken first and searched for class names from this backend's
 * target/classes: the exec format stores every class name in plain UTF-8.
 */
function agentRunsThisBackend(): { yes: boolean; reason: string } {
  const classNames = compiledClassNames(`${BACKEND_DIR}target/classes`, 500);
  if (classNames.length === 0) {
    return { yes: false, reason: `${BACKEND_DIR}target/classes holds no classes, so the agent cannot be verified as this backend's; build the backend first` };
  }
  const probe = `${BACKEND_DIR}target/jacoco-e2e-probe.exec`;
  try {
    maven('-q', 'jacoco:dump', `-Djacoco.destFile=${probe}`, '-Djacoco.append=false', '-Djacoco.reset=false');
    if (!existsSync(probe)) {
      return {
        yes: false,
        reason:
          `jacoco:dump ignored -Djacoco.destFile and wrote elsewhere: the profile's <destFile> is a literal value, which wins over the command line. ` +
          'Name it through the ${jacoco.destFile} property as the template in e2e/backend-coverage.ts does',
      };
    }
    const dump = readFileSync(probe, 'latin1');
    if (classNames.some((name) => dump.includes(name))) return { yes: true, reason: '' };
    return {
      yes: false,
      reason:
        `the agent on localhost:${JACOCO_AGENT_PORT} runs none of this backend's classes; it is another project's backend ` +
        `(lsof -iTCP:${JACOCO_AGENT_PORT} -sTCP:LISTEN). Give this project its own JACOCO_AGENT_PORT in project.ts`,
    };
  } finally {
    rmSync(probe, { force: true });
  }
}

export async function resetBackendCoverage(baseUrl: string | undefined): Promise<void> {
  // A report left over from an earlier run must not pass for this one's.
  rmSync(BACKEND_REPORT_DIR, { recursive: true, force: true });
  delete process.env[RESET_MARKER];

  if (!baseUrl) return frontendOnly('playwright.config.ts sets no baseURL.');
  if (!BACKEND_PRESENT) return frontendOnly(`no Maven project at ${BACKEND_DIR} (BACKEND_DIR in project.ts).`);
  // Against a remote stack, the agent on this machine belongs to a backend the run never calls.
  if (!isLocal(baseUrl)) return frontendOnly(`${baseUrl} is not a local stack.`);
  if (!(await portAnswers(JACOCO_AGENT_PORT, 1000))) {
    return frontendOnly(
      `no JaCoCo agent on localhost:${JACOCO_AGENT_PORT}. Start the backend with ${BACKEND_START_COMMAND}, see e2e/backend-coverage.ts.`,
    );
  }
  try {
    const identity = agentRunsThisBackend();
    if (!identity.yes) return frontendOnly(identity.reason);
    maven('-q', 'jacoco:dump', '-Djacoco.dump=false', '-Djacoco.reset=true');
    process.env[RESET_MARKER] = '1';
  } catch (failure) {
    frontendOnly(`resetting the agent failed. ${String(failure)}`);
  }
}

/**
 * Dumps the counters over TCP and turns them into jacoco.xml (read by coverage-gaps.ts), an HTML
 * report and a CSV.
 *
 * JaCoCo matches the counters to target/classes as they are now. When something recompiled the
 * backend after it started (a parallel session, an IDE build, a test run in another terminal), the
 * changed classes no longer match and report 0 %. JaCoCo only warns, so the names are written
 * down for coverage-gaps.ts.
 */
export async function writeBackendCoverageReport(): Promise<void> {
  if (process.env[RESET_MARKER] !== '1') return;
  try {
    const output = maven('jacoco:dump', '-Djacoco.append=false', 'jacoco:report');
    const mismatched = [...output.matchAll(/Execution data for class (\S+) does not match/g)].map((m) => m[1]);
    if (mismatched.length > 0) {
      writeFileSync(BACKEND_MISMATCH_FILE, `${mismatched.join('\n')}\n`);
      console.warn(
        `[JaCoCo] ${mismatched.length} backend classes were recompiled after the backend started and report ` +
          `0 %. Restart the backend (${BACKEND_START_COMMAND}) and re-run for true numbers.`,
      );
    }
    console.log(`[JaCoCo] backend report: ${pathToFileURL(`${BACKEND_REPORT_DIR}index.html`).href}`);
  } catch (failure) {
    rmSync(BACKEND_REPORT_DIR, { recursive: true, force: true });
    console.warn(`[JaCoCo] no backend report: ${String(failure)}`);
  }
}
