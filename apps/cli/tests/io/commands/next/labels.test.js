/** next fills a declared label below its minimum first, behind next.labelBounds [C7,#9164]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../../../packages/config/index.js';
import { describeSetting } from '../../../../../../packages/config/index.js';
import { main } from '../../../fixtures/native.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

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

test('cli.journeys-next-labels.with-next-labelbounds-on-and-a: clause 1: with next.labelBounds on and a label below its minimum next offers that label\'s top item [C7,#9164]', async t => {
  const { box, plain, quick } = await plainThenQuickWin(t, true);
  const text = await printed(box, box.seats.actor.path);
  assert.match(text, new RegExp(`claimed #${quick}:`, 'u'), 'the quick-win label is under its minimum, so its top item comes first');
  const at = id => text.search(new RegExp(`claimed #${id}:`, 'u'));
  assert.ok(at(plain) === -1 || at(quick) < at(plain), 'the quick win is claimed before the queue top');
});

test('cli.journeys-next-labels.next-offers-the-queue-top-once: clause 1: next offers the queue top once the label minimum is met [C7,#9164]', async t => {
  const { box, plain, quick } = await plainThenQuickWin(t, true);
  box.claim(quick);
  const text = await printed(box, box.seats.actor.path);
  assert.match(text, new RegExp(`claimed #${plain}:`, 'u'), 'another seat holds a quick win, so the minimum is met');
});

test('cli.journeys-next-labels.with-next-labelbounds-off-next-offers: clause 2: with next.labelBounds off next offers exactly the queue top [C7,#9164]', async t => {
  const { box, plain } = await plainThenQuickWin(t, false);
  const text = await printed(box, box.seats.actor.path);
  assert.match(text, new RegExp(`claimed #${plain}:`, 'u'));
});

test('cli.journeys-next-labels.next-labelbounds-is-a-described-setting: clause 2: next.labelBounds is a described setting [C7,#9164]', () => {
  assert.match(describeSetting('next.labelBounds')?.description ?? '', /minimum/u);
});

/**
 * A pinned quick win, a quick win another seat already holds (quick-win has a max of one holder) and a plain item.
 * Why a milestone pin: pins are the existing queue input that puts an item first, so the max must beat it.
 */
async function pinnedAtMax(t, on) {
  const box = await fixture(t, { projectConfig: { labels: { 'quick-win': { max: 1 } } } });
  const pinned = box.add('Pinned quick win at its label max', { brief: 'Files: web/pinned.js', expectedBuildMinutes: 5 });
  const held = box.add('Quick win another seat holds', { brief: 'Files: web/held.js', expectedBuildMinutes: 5 });
  const plain = box.add('Plain item', { brief: 'Files: web/plain.js' });
  box.claim(held);
  const added = await cli(box, box.root, ['milestone', 'add', 'Focus', '--items', `${pinned},${plain}`, '--reason', 'exercise a pin']);
  assert.equal(added.code, 0, added.out + added.err);
  const pin = await cli(box, box.root, ['milestone', 'pin', 'Focus', String(pinned), '--reason', 'pinned first']);
  assert.equal(pin.code, 0, pin.out + pin.err);
  labelBounds(on);
  return { box, pinned, plain };
}

test('cli.journeys-next-labels.with-next-labelbounds-on-next-does: clause 1: with next.labelBounds on, next does not offer a pinned item whose label is at its maximum [C7,#9165]', async t => {
  const { box, pinned, plain } = await pinnedAtMax(t, true);
  const text = await printed(box, box.seats.actor.path);
  assert.match(text, new RegExp(`claimed #${plain}:`, 'u'), 'the pin is capped by the quick-win max, so the next item is offered');
  assert.doesNotMatch(text, new RegExp(`claimed #${pinned}:`, 'u'));
});

test('cli.journeys-next-labels.pullboard-labels-json-lists-the-pinned: clause 2: pullboard labels --json lists the pinned item as capped [C7,#9165]', async t => {
  const { box, pinned } = await pinnedAtMax(t, true);
  const listed = await cli(box, box.seats.actor.path, ['labels']);
  assert.equal(listed.code, 0, listed.out + listed.err);
  assert.deepEqual(listed.document.capped, [{ item_id: pinned, labels: ['quick-win'] }]);
  assert.equal(listed.document.labels.find(row => row.label === 'quick-win').capped, true);
});

test('cli.journeys-next-labels.with-next-labelbounds-off-the-pin: clause 2: with next.labelBounds off the pin is honoured as on main [C7,#9165]', async t => {
  const { box, pinned } = await pinnedAtMax(t, false);
  const text = await printed(box, box.seats.actor.path);
  assert.match(text, new RegExp(`claimed #${pinned}:`, 'u'));
});

test('cli.journeys-next-labels.pullboard-labels-lists-the-automatic-labels: clause 1: pullboard labels --json on a board with no labels config lists the automatic labels lane:<name>, level:<value>, review:strict and quick-win for items that carry them [C7,#1519]', async t => {
  const box = await fixture(t);
  box.add('A quick web item', { brief: 'Files: web/quick.js', expectedBuildMinutes: 5 });
  box.add('A slow docs item', { lane: 'docs', brief: 'Files: docs/slow.js', expectedBuildMinutes: 25 });
  box.add('A strict review item', { brief: 'Files: web/strict.js', reviewFamily: 'anthropic' });
  const listed = await cli(box, box.seats.actor.path, ['labels']);
  assert.equal(listed.code, 0, listed.out + listed.err);
  const names = listed.document.labels.map(row => row.label);
  assert.ok(names.includes('lane:web'), `lane:web is listed with no config: ${names}`);
  assert.ok(names.includes('quick-win'), `quick-win is listed with no config: ${names}`);
  assert.ok(names.includes('review:strict'), `review:strict is listed with no config: ${names}`);
  assert.ok(names.some(name => name.startsWith('level:')), `a level:<value> label is listed with no config: ${names}`);
  assert.ok(names.every(name => /^(?:lane:|level:|review:strict$|broken-main$|quick-win$)/u.test(name)), `only automatic labels appear: ${names}`);
  assert.deepEqual(listed.document.unmet, [], 'no declared minimum, so none is unmet');
});
