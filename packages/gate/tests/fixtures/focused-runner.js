/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/** Launch the focused test runner on files in a fixture repository, as a pulled proof phase does [C7,#7937]. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('../../src/io/run/tests.js', import.meta.url));

/** The focused runner executable used by pulled-job fixtures [C7]. */
export function focusedRunnerPath() { return RUNNER; }

/** Run the runner on the given files in `cwd` with `env`; return its status and combined output. Why here: test files may not spawn node. */
export function runFocusedRunner(cwd, files, env) {
  const ran = spawnSync(process.execPath, [RUNNER, ...files], { cwd, encoding: 'utf8', timeout: 120_000, env });
  return { status: ran.status, text: `${ran.stdout}\n${ran.stderr}` };
}
