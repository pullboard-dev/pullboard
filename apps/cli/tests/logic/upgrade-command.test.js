/** pullboard update picks the upgrade command for an install kind, and refuses an unknown kind with one manual command [C7,#1303]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeCommand } from '../../src/logic/upgrade-command.js';

test('cli.logic-upgrade-command.command-per-install-kind: clause 1: upgradeCommand(kind) returns the npm install -g, npx cache refresh, or npm install --save-dev command for global, npx and project, and for unknown returns a refusal that names the one manual command [C7]', () => {
  assert.deepEqual(upgradeCommand('global', 'pullboard'), { command: 'npm install -g pullboard@latest' });
  assert.deepEqual(upgradeCommand('npx', 'pullboard'), { command: 'npx --yes pullboard@latest --version' });
  assert.deepEqual(upgradeCommand('project', 'pullboard'), { command: 'npm install --save-dev pullboard@latest' });
  for (const kind of ['unknown', '', undefined, 'toString']) {
    const { command, refusal } = upgradeCommand(kind, 'pullboard');
    assert.equal(command, undefined, `${String(kind)} gives no command`);
    assert.equal(refusal.code, 'UPDATE_KIND_UNKNOWN');
    assert.match(refusal.message, /npm install -g pullboard@latest/u, 'the refusal names the one manual command');
  }
  assert.throws(() => upgradeCommand('global', ''), TypeError);
});
