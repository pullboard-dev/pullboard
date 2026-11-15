/**
 * Report each test file's state while a run goes: one JSON line per change, appended to the file
 * PULLBOARD_TEST_PROGRESS names, saying a repository-relative path and running, green or red [P7].
 *
 * Why: a pulled gate or test job runs for minutes on a runner; runner serve reads these lines and posts them as the
 * job's progress step, so the board shows files finishing while the run goes, not only its receipt at the end.
 */
import { appendFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The env var naming the progress file; the test environment removes it, so a nested run never writes into it. */
export const PROGRESS_ENV = 'PULLBOARD_TEST_PROGRESS';

/**
 * The side reporters a run adds beside the caller's: the selection count when its env asks, and this progress
 * reporter when the runner's own environment names a progress file.
 *
 * @param {NodeJS.ProcessEnv} env - The tests' environment.
 * @param {NodeJS.ProcessEnv} [own] - The runner's own environment, which alone carries PULLBOARD_TEST_PROGRESS.
 * @returns {{ reporter: string, destination: string }[]}
 */
export function sideReporters(env, own = process.env) {
  return [
    ...(env.PULLBOARD_TEST_SELECTION ? [{ reporter: fileURLToPath(new URL('./selection.js', import.meta.url)), destination: devNull }] : []),
    ...(own[PROGRESS_ENV] ? [{ reporter: fileURLToPath(import.meta.url), destination: devNull }] : []),
  ];
}

/** A test file's path from the run's folder, or null when it is not a file inside it. */
function projectPath(file, root) {
  if (typeof file !== 'string' || !file) return null;
  const path = relative(root, file.startsWith('file:') ? fileURLToPath(file) : file).split(sep).join('/');
  return path && !path.startsWith('../') && path !== '..' && !isAbsolute(path) ? path : null;
}

/** Consume Node's event stream and append a line each time a file starts or finishes; it prints nothing. */
export default async function* reportProgress(events) {
  const target = process.env[PROGRESS_ENV], root = process.cwd();
  const seen = new Map();
  const say = (file, state) => {
    if (seen.get(file) === state) return;
    seen.set(file, state);
    try { appendFileSync(target, `${JSON.stringify({ file, state })}\n`); } catch { /* progress is a view; the run goes on */ }
  };
  for await (const event of events) {
    const file = projectPath(event.data?.file, root);
    if (!file || !target) continue;
    if (event.type === 'test:summary') say(file, event.data.success ? 'green' : 'red');
    // Node enqueues every file at the start; a file runs from its dequeue.
    else if (event.type === 'test:dequeue' && !seen.has(file)) say(file, 'running');
  }
}
