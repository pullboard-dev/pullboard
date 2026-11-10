/** Machine settings read and written through the config cell in a child, in a fixture's private machine home, with no CLI [Q4,C7]. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../child.js';

const CONFIG_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/config/index.js')).href;

/**
 * Call one config-cell settings function (setGateSlots, setBrowserSlots, loadMachineSettings) with the fixture's
 * PULLBOARD_MACHINE_HOME. The functions read the environment, so they run in a short child process.
 *
 * @param {{ first: string, env: Record<string, string> }} box - A resource suite fixture.
 * @param {'setGateSlots' | 'setBrowserSlots' | 'loadMachineSettings'} name
 * @param {...number} args
 * @returns {{ value?: any, error?: { code: string, message: string } }} The returned settings, or the refusal it threw.
 */
export function machineSettings(box, name, ...args) {
  const source = `import * as config from ${JSON.stringify(CONFIG_MODULE)};
try { process.stdout.write(JSON.stringify({ value: config[${JSON.stringify(name)}](...JSON.parse(process.argv[1])) })); }
catch (error) { process.stdout.write(JSON.stringify({ error: { code: error.code, message: error.message } })); }`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(args)], { cwd: box.first, env: box.env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.failure ?? ''}${result.stderr}`);
  return JSON.parse(result.stdout);
}
