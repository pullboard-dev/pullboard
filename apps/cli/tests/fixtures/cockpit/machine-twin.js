/** The same CLI call through a machine box twice, as a real process and in this process, for the parity test [C7,U149]. */

/**
 * Run `args` once with box.run (a real process) and once with box.inProcess.
 * Why: the launch lives here, in the fixture kit, so the test file launches no process itself.
 *
 * @param {{ run: Function, inProcess: Function }} box - A cockpit machine.
 * @param {string} cwd - Where the call runs.
 * @param {string[]} args - The CLI arguments.
 * @returns {Promise<{ real: string, inProcess: string }>} Both answers.
 */
export async function runTwice(box, cwd, args) {
  const real = box.run(cwd, ...args);
  const inProcess = await box.inProcess(cwd, ...args);
  return { real, inProcess };
}
