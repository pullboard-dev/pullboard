/**
 * Gate switches a fixture test sets in box.env, mirrored to files a pulled gate reads: the long-lived local runner's gate
 * child never sees a variable set between two commands [P7,C7,#5821]. Pure file helpers, so gate fixtures may import it.
 */
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';

/** The folder a fixture's gate switches are mirrored to, beside its machine home. */
function switchFolder(env) {
  return join(dirname(env.PULLBOARD_MACHINE_HOME), 'gate-switches');
}

/**
 * The fixture environment, where setting or deleting a non-Pullboard variable also writes or removes a file of that name
 * in the box's switch folder, which a fixture gate reads through fixtureSwitchSource.
 * Why: a pulled gate runs on the long-lived local runner, whose gate child never sees a variable the test sets between
 * two commands, so a switch such as LAND_SUPPRESS_RED reached no pulled gate (#7153).
 *
 * @param {Record<string, string | undefined>} env - The fixture environment object; it names PULLBOARD_MACHINE_HOME.
 * @returns {Record<string, string | undefined>} A proxy over the same object.
 */
export function runnerSwitchedEnv(env) {
  const mirror = (target, key) => {
    if (typeof key !== 'string' || key.startsWith('PULLBOARD_') || !/^[A-Z][A-Z0-9_]*$/u.test(key) || !target.PULLBOARD_MACHINE_HOME) return;
    const file = join(switchFolder(target), key);
    if (target[key] === undefined) rmSync(file, { force: true });
    else { mkdirSync(switchFolder(target), { recursive: true }); writeFileSync(file, String(target[key])); }
  };
  return new Proxy(env, {
    set(target, key, value) { target[key] = value; mirror(target, key); return true; },
    deleteProperty(target, key) { delete target[key]; mirror(target, key); return true; },
  });
}

/**
 * CommonJS source for a fixture gate script: `fixtureSwitch(name)` is the switch the test set last through
 * runnerSwitchedEnv, or the gate's own environment variable when the test never set it.
 *
 * @param {Record<string, string | undefined>} env - The fixture environment.
 * @returns {string}
 */
export function fixtureSwitchSource(env) {
  return `const fixtureSwitch = name => { try { return require('node:fs').readFileSync(require('node:path').join(${JSON.stringify(switchFolder(env))}, name), 'utf8'); } catch { return process.env[name]; } };`;
}
