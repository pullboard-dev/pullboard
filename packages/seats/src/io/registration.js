/** Keep disposable boards out of the person's machine inventory [N26,N35]. */
import { realpathSync } from 'node:fs';
import {
  homedir,
  tmpdir,
} from 'node:os';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

/** Resolve symlinked temporary roots as well as their spelling at the command line. */
function physicalPath(path) {
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

/** Compare whole path components so a temporary-directory sibling remains a normal project. */
function within(root, directory) {
  const path = relative(directory, root);
  return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

/**
 * A registry itself inside temporary storage is isolated from the person inventory and may hold fixtures.
 * Otherwise registration is for durable projects, not temporary roots, tests, previews, or agent scratch.
 */
export function projectRegistrationAllowed(root, env = process.env) {
  const temporary = [tmpdir(), '/tmp', '/private/tmp', '/var/tmp'].flatMap(path => [resolve(path), physicalPath(path)]);
  if (env.PULLBOARD_HOME && [resolve(env.PULLBOARD_HOME), physicalPath(env.PULLBOARD_HOME)]
    .every(path => temporary.some(directory => within(path, directory)))) return true;
  if (env.NODE_TEST_CONTEXT || env.PULLBOARD_TEST_RUNNER_PID || env.PULLBOARD_TRANSIENT === '1') return false;
  const paths = [resolve(root), physicalPath(root)];
  if (paths.some(path => temporary.some(directory => within(path, directory)))) return false;
  const home = physicalPath(homedir());
  return !paths.some(path => {
    const parts = relative(home, path).split(sep);
    return ['.claude', '.codex'].includes(parts[0]) && parts.slice(1).some(part => ['scratch', 'scratchpad', 'scratchpads', 'previews', 'worktrees', 'tmp'].includes(part));
  });
}
