/**
 * The checks the resident board process answers for a client that would otherwise start a node child for each [C7,#5330].
 * A call is a name and a JSON payload; the answer is a JSON value. The gate cell is loaded by file URL, so this cell takes no import edge into it.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const CHANGED_STATIC = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/src/io/changed/static.js')).href;
const REGISTRY = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/src/io/static/check/registry.js')).href;

/** The calls this process answers, by name. */
const CALLS = {
  /**
   * Run every registered static check not named in `skip` on the changed files, one after another, as the preflight's
   * children do: each check's failures are its non-empty lines, and a check that throws reports its message lines.
   */
  async preflight({ root, files, skip = [] }) {
    const [{ STATIC_CHECKS }, { changedStaticFailures }] = await Promise.all([import(REGISTRY), import(CHANGED_STATIC)]);
    const results = [];
    for (const { name } of STATIC_CHECKS) {
      if (skip.includes(name)) continue;
      const started = performance.now();
      let failures;
      try { failures = changedStaticFailures(root, files, { only: [name] }).join('\n').split('\n').filter(Boolean); }
      catch (error) { failures = String(error?.stack ?? error).split('\n').filter(Boolean); }
      results.push({ name, failures, ms: performance.now() - started });
    }
    return { results };
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
