/** The cockpit harness's sendBack answers its show read and reject in this process, with the same result as the real-process call [C7,U149]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  build,
  machine,
  project,
  sendBack,
  sendBackLocal,
} from '../../fixtures/cockpit/harness.js';
import { nodeLaunches } from '../../fixtures/launch-count.js';
import { fileFixtureItem } from '../../../../../packages/gate/tests/fixtures/testkit.js';

/** A submitted item #1 in a fresh machine, so each path sends back an identical board. */
function submitted() {
  const box = machine();
  const demo = project(box, 'demo');
  fileFixtureItem(box, demo.repo, { lane: 'web', title: 'Greeting', criterion: 'greets', args: ['--specs', 'G1'] });
  build(box, demo, 1, 'greeting.html');
  box.settled(demo.repo, 1);
  return { box, demo };
}

/** The item as the board shows it after the send-back, without times, hashes or the machine's folder. */
function afterwards({ box, demo }) {
  return box.run(demo.repo, 'show', '1', '--json')
    .split(box.dir).join('<box>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>')
    .replace(/\b[0-9a-f]{7,64}\b/g, '<hex>');
}

test('clause 1: sendBack as a real process and sendBackLocal in this process both exit clean and leave the same item and board state [C7,U149]', async () => {
  const viaProcess = submitted();
  const viaLocal = submitted();
  // Each helper's box refuses a non-zero exit, so finishing at all is the equal exit code.
  sendBack(viaProcess.box, viaProcess.demo, 1, 'the page needs a greeting');
  await sendBackLocal(viaLocal.box, viaLocal.demo, 1, 'the page needs a greeting');
  const real = afterwards(viaProcess);
  assert.equal(afterwards(viaLocal), real);
  assert.match(real, /the page needs a greeting/u, 'the reject note is on the item');
});

test('clause 2: sendBackLocal starts no CLI process and finishes under 40 s alone [C7,U149]', { timeout: 40_000 }, async () => {
  const scene = submitted();
  const launched = await nodeLaunches(() => sendBackLocal(scene.box, scene.demo, 1, 'the page needs a greeting'));
  assert.equal(launched, 0, 'no node child starts for the show read or the reject');
  const control = submitted();
  assert.ok(await nodeLaunches(async () => sendBack(control.box, control.demo, 1, 'the page needs a greeting')) >= 2, 'the real helper does start node children, so the count is live');
});
