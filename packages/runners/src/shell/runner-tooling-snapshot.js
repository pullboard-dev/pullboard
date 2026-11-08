/** Pin derived tooling bytes without a hand-maintained dependency list [C7,P3]. */
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { runnerPackage } from './runner-package.js';
import { runnerPackageReader } from './runner-package.js';
import { Refused } from '../../../kernel/index.js';
import { assertRunnerModuleParserCurrent } from './runner-module-parser.js';
import { createHash } from 'node:crypto';
import { importsWithCompiler as importsIn } from '../../../kernel/index.js';
import { createRunnerModuleParser } from './runner-module-parser.js';
import { parseWithPaths } from './runner-module-parser.js';

const readers = new WeakMap();
// The runners.js front door re-exports these step modules; a controller generation pins their bytes too.
const CONTROLLER_STEPS = ['packages/runners/index.js', 'packages/runners/src/shell/runners.js',
  'packages/runners/src/shell/runner-source-scan.js', 'packages/runners/src/shell/runner-history-pack.js',
  'packages/runners/src/shell/runner-remote-tooling.js', 'packages/runners/src/shell/runner-request.js',
  'packages/runners/src/shell/runner-result.js', 'packages/runners/src/shell/runner-dispatch.js',
  'packages/runners/src/shell/runner-health.js'];

/** Read each controller step's bytes, null when absent, so a fixture holding only runners.js still pins. */
function controllerSteps(root) {
  return CONTROLLER_STEPS.map(file => { try { return readFileSync(join(root, file), 'utf8'); } catch { return null; } });
}

/** Derive only package providers literally composed by the actual controller entry, using the canonical closure reader. */
function controllerProviderReader(root, source) {
  const parser = createRunnerModuleParser();
  let entries;
  try {
    entries = [...new Set(importsIn([source], parseWithPaths(parser.parse, [join(resolve(root), 'bin/runner-controller.js')]))[0]
      .filter(specifier => specifier.startsWith('../packages/'))
      .map(specifier => specifier.slice(3)))].sort();
  } finally { parser.close(); }
  const providers = entries.map(entry => runnerPackageReader(root, entry));
  const digest = () => {
    const hash = createHash('sha256');
    digest.files = new Set();
    for (const read of providers) {
      const runtime = read();
      for (const [file, source] of Object.entries(runtime.files)) {
        digest.files.add(file);
        hash.update(JSON.stringify([file, Buffer.byteLength(source)]) + '\n');
        hash.update(source);
      }
    }
    return hash.digest('hex');
  };
  return digest;
}

// Linux stamps files from a tick-granular clock that can lag Date.now() by up to 10 ms.
const COARSE_CLOCK_MS = 10;

/**
 * Report whether any pinned file's inode changed after the given process-load instant.
 * Why: a capture deferred to first dispatch must still refuse bytes changed since this controller loaded;
 * ctime moves on every write and cannot be set back, and the margin keeps a coarse clock from hiding one.
 */
function changedSince(root, files, since) {
  return files.some(file => {
    try { return statSync(join(root, file)).ctimeMs > since - COARSE_CLOCK_MS; } catch { return false; }
  });
}

/**
 * Capture the worker closure and actual controller bytes; with since, null when any was written after it.
 * Why: callers capture at first dispatch, so since (the controller's load instant) keeps the load-time pin.
 */
export function captureRunnerTooling(root, { since } = {}) {
  const read = runnerPackageReader(root);
  const controllerEntry = readFileSync(join(root, 'bin/runner-controller.js'), 'utf8');
  const providers = controllerProviderReader(root, controllerEntry);
  const loaded = { ...read(), controller: readFileSync(join(root, 'src/runners.js'), 'utf8'),
    controllerEntry, controllerSteps: controllerSteps(root),
    controllerProviders: providers() };
  if (since !== undefined && changedSince(root, [...Object.keys(loaded.files), 'src/runners.js',
    'bin/runner-controller.js', ...CONTROLLER_STEPS, ...providers.files], since)) return null;
  readers.set(loaded, { root: resolve(root), read, providers });
  return loaded;
}

/** Refuse stale pinned bytes before parsing dependencies again; newly reached files also require a restart. */
export function currentRunnerTooling(root, loaded, { rescan = true } = {}) {
  assertRunnerModuleParserCurrent();
  /** Keep every stale generation on the existing typed restart path. */
  const refuse = () => { throw new Refused('RUNNER_TOOLING_CHANGED', 'runner tooling changed since this controller loaded; restart the command from the current committed CLI before retrying'); };
  if (loaded?.problem?.code === 'RUNNER_TOOLING_FILES') throw loaded.problem;
  if (!loaded) return refuse();
  const reader = readers.get(loaded);
  try {
    if (readFileSync(join(root, 'src/runners.js'), 'utf8') !== loaded.controller
      || readFileSync(join(root, 'bin/runner-controller.js'), 'utf8') !== loaded.controllerEntry
      || JSON.stringify(controllerSteps(root)) !== JSON.stringify(loaded.controllerSteps)
      || (reader?.root === resolve(root) ? reader.providers() : controllerProviderReader(root, loaded.controllerEntry)()) !== loaded.controllerProviders
      || Object.entries(loaded.files).some(([name, source]) => readFileSync(join(root, name), 'utf8') !== source)) return refuse();
  } catch (error) {
    if (error.code === 'RUNNER_TOOLING_FILES') throw error;
    return refuse();
  }
  if (!rescan) return { entry: loaded.entry, files: loaded.files };
  const current = reader?.root === resolve(root) ? reader.read() : runnerPackage(root);
  if (current.entry !== loaded.entry || JSON.stringify(current.files) !== JSON.stringify(loaded.files)) return refuse();
  return current;
}
