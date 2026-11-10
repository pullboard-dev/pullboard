import { controllerPolicyFingerprints } from '../package.js';
/** Pin derived tooling bytes without a hand-maintained dependency list [C7,P3]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { runnerPackage } from '../package.js';
import { runnerPackageReader } from '../package.js';
import { Refused } from '../../../../kernel/index.js';
import { assertRunnerModuleParserCurrent } from '../module/parser.js';
import { createHash } from 'node:crypto';
import { importsWithCompiler as importsIn } from '../../../../kernel/index.js';
import { createRunnerModuleParser } from '../module/parser.js';
import { parseWithPaths } from '../module/parser.js';

const readers = new WeakMap();
let lastCaptureReaders = null;
// The runners.js front door re-exports these step modules; a controller generation pins their bytes too.
const CONTROLLER_STEPS = ['packages/runners/index.js', 'packages/runners/src/io/main.js',
  'packages/runners/src/io/source/scan.js', 'packages/runners/src/io/pack.js',
  'packages/runners/src/io/tooling/remote.js', 'packages/runners/src/io/request.js',
  'packages/runners/src/io/result.js', 'packages/runners/src/io/dispatch.js',
  'packages/runners/src/io/health.js'];

/** Read each controller step's bytes, null when absent, so a fixture holding only runners.js still pins. */
function controllerSteps(root) {
  return CONTROLLER_STEPS.map(file => { try { return readFileSync(join(root, file), 'utf8'); } catch { return null; } });
}

/** Derive only package providers literally composed by the actual controller entry, using the canonical closure reader. */
function controllerProviderReader(root, source) {
  const parser = createRunnerModuleParser();
  let entries;
  try {
    entries = [...new Set(importsIn([source], parseWithPaths(parser.parse, [join(resolve(root), 'apps/runner/src/io/controller.js')]))[0]
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

/** The controller facade file this tree pins: packages/runners/index.js in a 0.9.3 layout while it exists, else the cell door. */
export function controllerFile(root) {
  return existsSync(join(root, 'src/runners.js')) ? 'src/runners.js' : 'packages/runners/index.js';
}

/** Select the controller entry present in the captured tree, including the legacy layout. */
function controllerEntryFile(root) {
  return existsSync(join(root, 'apps/runner/src/io/controller.js'))
    ? 'apps/runner/src/io/controller.js' : 'bin/runner-controller.js';
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
  const absoluteRoot = resolve(root);
  const entryFile = controllerEntryFile(root);
  const controllerEntry = readFileSync(join(root, entryFile), 'utf8');
  if (lastCaptureReaders?.root !== absoluteRoot || lastCaptureReaders.entry !== controllerEntry || lastCaptureReaders.entryFile !== entryFile) {
    lastCaptureReaders = {
      root: absoluteRoot,
      entry: controllerEntry,
      entryFile,
      read: runnerPackageReader(absoluteRoot),
      providers: controllerProviderReader(absoluteRoot, controllerEntry),
    };
  }
  const { read, providers } = lastCaptureReaders;
  const loaded = { ...read(), controller: readFileSync(join(root, controllerFile(root)), 'utf8'),
    controllerEntry, controllerEntryFile: entryFile, controllerSteps: controllerSteps(root), controllerPolicy: controllerPolicyFingerprints(root),
    controllerProviders: providers() };
  if (since !== undefined && changedSince(root, [...Object.keys(loaded.files), controllerFile(root),
    entryFile, ...CONTROLLER_STEPS, ...providers.files], since)) return null;
  readers.set(loaded, { root: resolve(root), read, providers });
  return loaded;
}

/** Re-read the pinned controller graph, so edits to helper bodies are caught even without a closure rescan. */
function sameControllerPolicy(root, policy) {
  return Boolean(policy) && Object.entries(policy).every(([file, digest]) =>
    createHash('sha256').update(readFileSync(join(root, file))).digest('hex') === digest);
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
    if (readFileSync(join(root, controllerFile(root)), 'utf8') !== loaded.controller
      || controllerEntryFile(root) !== loaded.controllerEntryFile
      || readFileSync(join(root, loaded.controllerEntryFile), 'utf8') !== loaded.controllerEntry
      || JSON.stringify(controllerSteps(root)) !== JSON.stringify(loaded.controllerSteps)
      || !sameControllerPolicy(root, loaded.controllerPolicy)
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
