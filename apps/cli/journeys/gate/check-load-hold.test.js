/** With machine.holdHeavyAboveLoad on, pullboard check waits in the local resource line above machine.loadCeiling and says so; off, it reports as before [C7,#10141]. @pullboard-test-input source-cell apps/cli packages/config packages/resources */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { setMachineLoadPort } from '../../../../packages/resources/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const WAIT_LINE = 'pullboard check waits in the local resource line';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A fixture project whose seat holds item 1 with a trivial check, ready for pullboard check 1 --yes. */
async function seat() {
  const box = e2e.project();
  await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Check under load', check: 'true', wait: true, run: box.runLocal });
  const claimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  return box;
}

/** Merge the machine hold settings into the fixture machine's settings file, keeping what the fixture wrote. */
function holdSettings(box, machine) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { /* the fixture wrote none */ }
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...settings, machine: { ...settings.machine, ...machine } }));
}

/**
 * Run the real pullboard check 1 --yes in this process with an injected 1-minute load of 30 on 4 cores, and collect what it writes to
 * stderr. Once the wait line appears the injected load drops to 0, so the held check admits and reports; `waited` says whether the line came first.
 */
async function checkUnderLoad(t, box) {
  let loadNow = 30;
  const restore = setMachineLoadPort({ loadavg: () => [loadNow, loadNow, loadNow], cores: () => 4 });
  const savedHeld = process.env.PULLBOARD_GATE_SLOT_HELD;
  delete process.env.PULLBOARD_GATE_SLOT_HELD;
  const write = process.stderr.write;
  let seen = '';
  process.stderr.write = function capture(chunk, ...rest) {
    seen += String(chunk);
    if (seen.includes(WAIT_LINE)) loadNow = 0;
    return write.call(this, chunk, ...rest);
  };
  t.after(() => {
    process.stderr.write = write;
    restore();
    if (savedHeld === undefined) delete process.env.PULLBOARD_GATE_SLOT_HELD; else process.env.PULLBOARD_GATE_SLOT_HELD = savedHeld;
  });
  const result = await box.runLocal(box.web, 'check', '1', '--yes');
  return { result, seen, waitedFirst: seen.includes(WAIT_LINE) && result.out.includes('check green in') };
}

test('clause 1: with the setting on and the load over machine.loadCeiling, pullboard check waits in the local resource line before it reports [C7,#10141]', { timeout: 180_000 }, async t => { // budget: hang ceiling for one real in-process check; not a speed target.
  const box = await seat();
  holdSettings(box, { holdHeavyAboveLoad: true });
  const answer = await checkUnderLoad(t, box);
  assert.match(answer.seen, new RegExp(`${WAIT_LINE}: load: holding heavy local work`, 'u'), answer.result.err);
  assert.equal(answer.result.code, 0, answer.result.out + answer.result.err);
  assert.match(answer.result.out, /check green in/u, 'once the load drops the held check runs and reports');
});

test('clause 2: with the setting off, the same check under the same load reports green and prints no wait line [C7,#10141]', { timeout: 180_000 }, async t => {
  const box = await seat();
  holdSettings(box, { holdHeavyAboveLoad: false });
  const answer = await checkUnderLoad(t, box);
  assert.equal(answer.result.code, 0, answer.result.out + answer.result.err);
  assert.match(answer.result.out, /check green in/u);
  assert.doesNotMatch(answer.seen, new RegExp(WAIT_LINE, 'u'));
});
