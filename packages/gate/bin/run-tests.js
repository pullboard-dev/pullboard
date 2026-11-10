/**
 * The gate entry packages/gate/src/io/run/tests.js launches: it loads the test runner engine here, never from the light door.
 * Why: gate/core.js is in the runner worker bundle, which must not reach the engine's closure.
 *
 * @param {Parameters<typeof import('../src/io/run-tests.js').startRunTests>[0]} launcher
 * @returns {Promise<void>}
 */
export async function startRunTests(launcher) {
  return (await import('../src/io/run-tests.js')).startRunTests(launcher);
}
