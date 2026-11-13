/** No test process starts on the coordinator: tests run on runners, by a runner job, or nowhere [C7]. */
/** The variable a runner job sets on every process it starts; a process without it is not a runner job. */
export const RUNNER_JOB_ENV = 'PULLBOARD_RUNNER_JOB';

/** The refusal code a test run on the coordinator ends with. */
export const TESTS_ON_COORDINATOR = 'TESTS_ON_COORDINATOR';

/**
 * Whether this machine is the coordinator: its machine settings say gate.runnersOnly, so every test belongs on a
 * runner. Unreadable settings never make a machine the coordinator.
 *
 * @param {() => any} read - Reads the machine settings (config's loadMachineSettings); passed in, since the gate cell imports no other cell here.
 * @returns {boolean}
 */
export function isCoordinatorMachine(read) {
  try { return read()?.gate?.runnersOnly === true; } catch { return false; }
}

/**
 * The refusal for a test process about to start here, or null when it may: on the coordinator only a runner job may
 * run tests. Why: on 8 Nov an orphaned gate worker and three agent node --test runs drove the Mac to load 55-78 and
 * stalled every gate; a test run on the coordinator must be impossible, not discouraged (#3899).
 *
 * @param {{ env?: NodeJS.ProcessEnv, read: () => any }} options - read is config's loadMachineSettings.
 * @returns {string | null}
 */
export function coordinatorTestRefusal({ env = process.env, read }) {
  if (env[RUNNER_JOB_ENV] || !isCoordinatorMachine(read)) return null;
  return `[${TESTS_ON_COORDINATOR}] tests never run on the coordinator (gate.runnersOnly); run them on a runner with pullboard test <file>`;
}

/**
 * Stop this process before any test runs when it is a test run on the coordinator: shared test helpers call it on
 * load, so a bare node --test of a suite that uses them refuses too.
 *
 * @param {{ env?: NodeJS.ProcessEnv, read: () => any, exit?: (code: number) => never, write?: (text: string) => void }} options - read is config's loadMachineSettings.
 */
export function refuseTestsOnCoordinator({ env = process.env, read, exit = code => process.exit(code), write = text => process.stderr.write(text) } = {}) {
  const refusal = coordinatorTestRefusal({ env, read });
  if (!refusal) return;
  write(refusal + '\n');
  exit(2);
}

/**
 * Test processes running on this machine, as `ps` lists them: node processes running apps/cli/src/io/run/tests.js or node --test.
 *
 * @param {string} listing - `ps -axo pid=,command=` output.
 * @returns {{ pid: number, command: string }[]}
 */
export function testProcesses(listing) {
  return String(listing).split('\n').map(line => /^\s*(\d+)\s+(.*)$/u.exec(line)).filter(Boolean)
    .map(([, pid, command]) => ({ pid: Number(pid), command }))
    .filter(row => /\bnode\b/u.test(row.command) && /(?:bin\/run-tests\.js|\s--test(?:\s|=|$))/u.test(row.command));
}
