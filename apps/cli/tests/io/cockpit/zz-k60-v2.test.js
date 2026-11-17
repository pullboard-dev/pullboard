/** @pullboard-test-input source-cell apps/cli */
/** Scratch bisect 2. */
import { test } from 'node:test';
import {
  buildLocal,
  machine,
  project,
  sendBack,
  sendBackLocal,
} from '../../fixtures/cockpit/harness.js';
import { fileFixtureItem } from '../../../../../packages/gate/tests/fixtures/testkit.js';
test('clause 1: bisect v2 [C7]', async () => {
  const box = machine();
  const demo = project(box, 'demo');
  fileFixtureItem(box, demo.repo, { lane: 'web', title: 'Greeting', criterion: 'greets', args: ['--specs', 'G1'] });
  await buildLocal(box, demo, 1, 'greeting.html', { queued: true });
  box.settled(demo.repo, 1);
  void sendBack;
  void sendBackLocal;
  await sendBackLocal(box, demo, 1, 'x');
});
