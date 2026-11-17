/**
 * The checks the resident board process answers for a client that would otherwise start a node child for each [C7,#5330].
 * A call is a name and a JSON payload; the answer is a JSON value. The gate cell is loaded by file URL, so this cell takes no import edge into it.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

const CHANGED_STATIC = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/src/io/changed/static.js')).href;
const REGISTRY = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/src/io/static/check/registry.js')).href;
const CHECK_WORKER = new URL('./check-worker.js', import.meta.url);
/** What a check throws in a process started without --experimental-vm-modules, as the resident process is. */
const NEEDS_VM_MODULES = /experimental-vm-modules/u;

/**
 * Run the named static checks on the changed files, one after another, as the preflight's children do: a check's failures
 * are its non-empty lines, and a check that throws reports its message lines. A check that needs VM modules, which this
 * thread lacks, is marked `needsVm` and judged again in a worker.
 *
 * @param {string} root - Checkout root.
 * @param {string[]} files - Root-relative changed files.
 * @param {string[]} names - Registered check names.
 * @returns {Promise<{ name: string, failures: string[], ms: number, needsVm?: boolean }[]>}
 */
export async function checkResults(root, files, names) {
  const { changedStaticFailures } = await import(CHANGED_STATIC);
  return names.map((name) => {
    const started = performance.now();
    try { return { name, failures: changedStaticFailures(root, files, { only: [name] }).join('\n').split('\n').filter(Boolean), ms: performance.now() - started }; }
    catch (error) {
      const text = String(error?.stack ?? error);
      return { name, failures: text.split('\n').filter(Boolean), ms: performance.now() - started, ...(NEEDS_VM_MODULES.test(text) ? { needsVm: true } : {}) };
    }
  });
}

/** Judge checks again on a worker thread started with VM modules, which no node child is needed for. */
function inWorker(root, files, names) {
  return new Promise((done, fail) => {
    const worker = new Worker(CHECK_WORKER, { workerData: { root, files, names }, execArgv: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'] });
    worker.once('message', done);
    worker.once('error', fail);
    worker.once('exit', (code) => fail(new Error(`the check worker exited ${code} without an answer`)));
  });
}

/** The calls this process answers, by name. */
const CALLS = {
  /** Run every registered static check not named in `skip` on the changed files. */
  async preflight({ root, files, skip = [] }) {
    const { STATIC_CHECKS } = await import(REGISTRY);
    let results = await checkResults(root, files, STATIC_CHECKS.map((check) => check.name).filter((name) => !skip.includes(name)));
    const again = results.filter((row) => row.needsVm).map((row) => row.name);
    if (again.length) {
      const judged = await inWorker(root, files, again);
      results = results.map((row) => judged.find((other) => other.name === row.name) ?? row);
    }
    return { results: results.map(({ name, failures, ms }) => ({ name, failures, ms })) };
  },
};

/** Whether this process answers a call by this name. */
export function knownCall(name) {
  return Object.hasOwn(CALLS, name);
}

/**
 * Answer one call.
 *
 * @param {string} name - A name `knownCall` accepts.
 * @param {object} payload - The call's JSON arguments.
 * @returns {Promise<object>} The call's JSON answer.
 */
export function answerCall(name, payload) {
  return CALLS[name](payload);
}
