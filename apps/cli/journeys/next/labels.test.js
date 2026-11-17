/** next fills a declared label below its minimum first, behind next.labelBounds [C7,#9164]. @pullboard-test-input source-cell apps/cli packages/config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { describeSetting } from '../../../../packages/config/index.js';
import { main } from '../../tests/fixtures/native.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Turn next.labelBounds on or off for this fixture's machine, keeping the settings the fixture wrote. */
function labelBounds(on) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, next: { labelBounds: on } }));
}

/** Run next as a person reads it, with no --json, and return everything it printed. */
async function printed(box, cwd) {
  let out = '';
  const stdout = { isTTY: false, write: part => { out += part; } };
  const code = await main(['next'], { cwd, clock: box.clock, stdout, stderr: stdout });
  assert.equal(code, 0, out);
  return out;
}

/** The queue top is a plain item; the second item is a quick win, and quick-win has a minimum of one holder. */
async function plainThenQuickWin(t, on) {
  const box = await fixture(t, { projectConfig: { labels: { 'quick-win': { min: 1 } } } });
  const plain = box.add('Plain queue top', { brief: 'Files: web/plain.js' });
  const quick = box.add('Quick win below its minimum', { brief: 'Files: web/quick.js', expectedBuildMinutes: 5 });
  labelBounds(on);
  return { box, plain, quick };
}

test('clause 1: with next.labelBounds on and a label below its minimum next offers that label\'s top item [C7,#9164]', async t => {
  const { box, plain, quick } = await plainThenQuickWin(t, true);
  const text = await printed(box, box.seats.actor.path);
  assert.match(text, new RegExp(`claimed #${quick}:`, 'u'), 'the quick-win label is under its minimum, so its top item comes first');
  const at = id => text.search(new RegExp(`claimed #${id}:`, 'u'));
  assert.ok(at(plain) === -1 || at(quick) < at(plain), 'the quick win is claimed before the queue top');
});

test('clause 1: next offers the queue top once the label minimum is met [C7,#9164]', async t => {
  const { box, plain, quick } = await plainThenQuickWin(t, true);
  box.claim(quick);
  const text = await printed(box, box.seats.actor.path);
  assert.match(text, new RegExp(`claimed #${plain}:`, 'u'), 'another seat holds a quick win, so the minimum is met');
});

test('clause 2: with next.labelBounds off next offers exactly the queue top [C7,#9164]', async t => {
  const { box, plain } = await plainThenQuickWin(t, false);
  const text = await printed(box, box.seats.actor.path);
  assert.match(text, new RegExp(`claimed #${plain}:`, 'u'));
});

test('clause 2: next.labelBounds is a described setting [C7,#9164]', () => {
  assert.match(describeSetting('next.labelBounds')?.description ?? '', /minimum/u);
});
