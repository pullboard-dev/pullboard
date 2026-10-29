/** Pin derived tooling bytes without a hand-maintained dependency list [C7,P3]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { runnerPackage } from './runner-package.js';
import { runnerPackageReader } from './runner-package.js';
import { Refused } from './refused.js';
import { assertRunnerModuleParserCurrent } from './runner-module-parser.js';

const readers = new WeakMap();
// The runners.js front door re-exports these step modules; a controller generation pins their bytes too.
const CONTROLLER_STEPS = ['src/runner-source-scan.js', 'src/runner-history-pack.js', 'src/runner-remote-tooling.js',
  'src/runner-request.js', 'src/runner-result.js', 'src/runner-dispatch.js', 'src/runner-health.js'];

/** Read each controller step's bytes, null when absent, so a fixture holding only runners.js still pins. */
function controllerSteps(root) {
  return CONTROLLER_STEPS.map(file => { try { return readFileSync(join(root, file), 'utf8'); } catch { return null; } });
}

/** Capture the worker closure and actual controller bytes at module load, not at first dispatch. */
export function captureRunnerTooling(root) {
  const read = runnerPackageReader(root);
  const loaded = { ...read(), controller: readFileSync(join(root, 'src/runners.js'), 'utf8'),
    controllerEntry: readFileSync(join(root, 'bin/runner-controller.js'), 'utf8'), controllerSteps: controllerSteps(root) };
  readers.set(loaded, { root: resolve(root), read });
  return loaded;
}

/** Refuse stale pinned bytes before parsing dependencies again; newly reached files also require a restart. */
export function currentRunnerTooling(root, loaded, { rescan = true } = {}) {
  assertRunnerModuleParserCurrent();
  /** Keep every stale generation on the existing typed restart path. */
  const refuse = () => { throw new Refused('RUNNER_TOOLING_CHANGED', 'runner tooling changed since this controller loaded; restart the command from the current committed CLI before retrying'); };
  if (loaded?.problem?.code === 'RUNNER_TOOLING_FILES') throw loaded.problem;
  if (!loaded) return refuse();
  try {
    if (readFileSync(join(root, 'src/runners.js'), 'utf8') !== loaded.controller
      || readFileSync(join(root, 'bin/runner-controller.js'), 'utf8') !== loaded.controllerEntry
      || JSON.stringify(controllerSteps(root)) !== JSON.stringify(loaded.controllerSteps)
      || Object.entries(loaded.files).some(([name, source]) => readFileSync(join(root, name), 'utf8') !== source)) return refuse();
  } catch { return refuse(); }
  if (!rescan) return { entry: loaded.entry, files: loaded.files };
  const reader = readers.get(loaded);
  const current = reader?.root === resolve(root) ? reader.read() : runnerPackage(root);
  if (current.entry !== loaded.entry || JSON.stringify(current.files) !== JSON.stringify(loaded.files)) return refuse();
  return current;
}
