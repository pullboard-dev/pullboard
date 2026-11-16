/**
 * A stand-in for the test runner, for packages/gate/tests/stable.test.js: it names itself in PULLBOARD_TEST_RUNNER_PID and runs the probe as its child, the way the runner does for a test file [C7].
 * Why: the real runner takes a browser slot and queues behind every other Chrome on the machine, minutes per case; the runner's naming is proved by packages/gate/tests/runner/pid.test.js.
 */
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, process.argv.slice(2), { env: { ...process.env, PULLBOARD_TEST_RUNNER_PID: String(process.pid) }, stdio: 'ignore' });
child.once('exit', code => process.exit(code ?? 1));
