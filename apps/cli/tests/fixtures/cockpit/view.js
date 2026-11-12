/** Keep fixture-owned init commands from leaving an automatic view behind. */
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

/**
 * Disable background view startup in the effective machine home of a private test fixture.
 * This mirrors src/machine-home.js: PULLBOARD_MACHINE_HOME wins; otherwise the OS account home is used.
 * @param {NodeJS.ProcessEnv} env Environment that the fixture will pass to its init command.
 * @param {string} privateRoot Existing realpath root owned by this fixture.
 * @returns {{machineHome:string,settingsFile:string}}
 */
export function disableFixtureBackgroundView(env, privateRoot) {
  const root = realpathSync(privateRoot);
  const machineHome = resolve(env.PULLBOARD_MACHINE_HOME || join(userInfo().homedir, '.pullboard'));
  const pathFromRoot = relative(root, machineHome);
  assert.ok(pathFromRoot && pathFromRoot !== '..' && !pathFromRoot.startsWith('..' + sep) && !isAbsolute(pathFromRoot),
    'fixture machine home must be inside its private root; refusing to touch the user machine home');

  let cursor = root;
  for (const component of pathFromRoot.split(sep)) {
    cursor = join(cursor, component);
    try {
      const info = lstatSync(cursor);
      assert.ok(info.isDirectory() && !info.isSymbolicLink(), `fixture machine-home path is not a real directory: ${cursor}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(cursor);
    }
  }
  assert.equal(realpathSync(machineHome), machineHome, 'fixture machine home does not traverse a symlink');

  const settingsFile = join(machineHome, 'settings.json');
  let current = {};
  try {
    const info = lstatSync(settingsFile);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1,
      'fixture settings must be a private regular file, not a symlink or hard link');
    current = JSON.parse(readFileSync(settingsFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert.ok(current && typeof current === 'object' && !Array.isArray(current), 'fixture settings must be a JSON object');
  const view = current.view === undefined ? {} : current.view;
  assert.ok(view && typeof view === 'object' && !Array.isArray(view), 'fixture settings.view must be a JSON object');
  if (view.background === false) return { machineHome, settingsFile };
  current.view = { ...view, background: false };
  writeFileSync(settingsFile, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  return { machineHome, settingsFile };
}
