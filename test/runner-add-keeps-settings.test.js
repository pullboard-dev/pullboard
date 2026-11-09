/** Registration preserves remote configuration [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { registrationGuiFixture } from './runner-registration-gui-fixture.js';
import { cli } from './runner-tooling-fixture.js';
import { HOST } from './runner-ssh-fixture.js';

test('runner add discovers Node and keeps node and root on re-registration [C7]', t => {
  const box = registrationGuiFixture(t);
  const discovered = box.register();
  assert.match(discovered.node, /^\//u);
  const first = cli(box.repo, box.env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--node', process.execPath, '--root', join(box.directory, 'remote-root'), '--json');
  assert.equal(first.status, 0, first.context);
  const again = box.register();
  assert.equal(again.node, process.execPath);
  assert.equal(again.root, join(box.directory, 'remote-root'));
});
