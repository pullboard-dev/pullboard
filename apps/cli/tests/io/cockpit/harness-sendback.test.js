/** The cockpit harness's sendBack answers its show read and reject in this process, with the same result as the real-process call [C7,U149]. */
import assert from 'node:assert/strict';
import {
  before,
  test,
} from 'node:test';
import {
  buildLocal,
  machine,
  project,
  sendBack,
  sendBackLocal,
} from '../../fixtures/cockpit/harness.js';
import { nodeLaunches } from '../../fixtures/launch-count.js';
import { fileFixtureItem } from '../../../../../packages/gate/tests/fixtures/testkit.js';

const NOTE = 'the page needs a greeting';
let viaProcess;
let viaLocal;
let launches;

/** A submitted item #1 in a fresh machine, so each path sends back an identical board. */
async function submitted() {
  const box = machine();
  const demo = project(box, 'demo');
  // The machine's run returns stdout and refuses a non-zero status, so it is shaped as the testkit's result.
  fileFixtureItem(box, demo.repo, { lane: 'web', title: 'Greeting', criterion: 'greets', args: ['--specs', 'G1'], run: (cwd, ...args) => ({ status: 0, stdout: box.run(cwd, ...args) }) });
  await buildLocal(box, demo, 1, 'greeting.html', { queued: true });
  box.settled(demo.repo, 1);
  return { box, demo };
}

/** The item as the board shows it after the send-back: its settled state and whether the reject note reached it, without ids, times or paths. */
function afterwards({ box, demo }) {
  const shown = box.run(demo.repo, 'show', '1', '--json');
  const item = JSON.parse(shown);
  return { status: item.item_status, title: item.item_title, builtBy: item.item_built_by, criterion: item.item_criterion, noted: shown.includes(NOTE) };
}

before(async () => {
  viaProcess = await submitted();
  viaLocal = await submitted();
  launches = {
    real: await nodeLaunches(async () => sendBack(viaProcess.box, viaProcess.demo, 1, NOTE)),
    local: await nodeLaunches(() => sendBackLocal(viaLocal.box, viaLocal.demo, 1, NOTE)),
  };
});

test('clause 1: sendBack as a real process and sendBackLocal in this process both exit clean and leave the same item and board state [C7,U149]', () => {
  // Each helper's box refuses a non-zero exit, so reaching this point is the equal exit code.
  const real = afterwards(viaProcess);
  assert.deepEqual(afterwards(viaLocal), real);
  assert.equal(real.noted, true, 'the reject note is on the item');
});

test('clause 2: sendBackLocal starts no CLI process and finishes under 40 s alone [C7,U149]', { timeout: 40_000 }, () => {
  assert.equal(launches.local, 0, 'no node child starts for the show read or the reject');
  assert.ok(launches.real >= 2, 'the real helper does start node children, so the count is live');
});
