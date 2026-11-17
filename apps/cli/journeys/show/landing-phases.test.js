/** pullboard show prints the phases of the landing receipt that merged an item, from the landing fixture's real runner job [C7,#9079]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';

const NAMED = ['merge', 'static checks', 'cli smoke', 'push'];

test('clause 1: show --json for a landed item carries landing.phases as {phase, ms} rows naming merge, static checks, cli smoke and push as the runner job recorded them [C7,#9079]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  const entry = fixtures.itemWorktree(box, 1);
  fixtures.submitItem(box, entry);
  fixtures.acceptItem(box, entry);
  const offered = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(offered.code, 0, offered.err + offered.out);
  const landed = await settleLand(box, JSON.parse(offered.out));
  assert.equal(landed.batch.state, 'landed', JSON.stringify(landed.landJob.receipt));
  const recorded = landed.landJob.receipt.phases.filter(row => typeof row.phase === 'string' && Number.isSafeInteger(row.ms));
  const shown = await box.runLocal(box.repo, 'show', String(entry.item), '--json');
  assert.equal(shown.code, 0, shown.err);
  const { landing } = JSON.parse(shown.out);
  assert.ok(Array.isArray(landing.phases) && landing.phases.length > 0, shown.out);
  for (const row of landing.phases) assert.deepEqual(Object.keys(row).sort(), ['ms', 'phase']);
  const names = landing.phases.map(row => row.phase);
  for (const name of NAMED) assert.ok(names.includes(name), `${name} is named in ${names.join(', ')}`);
  assert.deepEqual(landing.phases, recorded.filter(row => landing.phases.some(kept => kept.phase === row.phase && kept.ms === row.ms)));
});

test('clause 2: show prints one line per phase, and an item landed before phases were kept prints none and no error [C7,#9079]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  const entry = fixtures.itemWorktree(box, 1);
  const before = await box.runLocal(box.repo, 'show', String(entry.item));
  assert.equal(before.code, 0, before.err);
  assert.doesNotMatch(before.out, /landing phase/u);
  // An item with no recorded landing (as one landed before phases were kept) prints no phase line and no error, in text and in JSON.
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', String(entry.item), '--json')).out).landing, undefined);
  fixtures.submitItem(box, entry);
  fixtures.acceptItem(box, entry);
  const offered = await box.runLocal(box.repo, 'land', '--json');
  const landed = await settleLand(box, JSON.parse(offered.out));
  assert.equal(landed.batch.state, 'landed', JSON.stringify(landed.landJob.receipt));
  const shown = await box.runLocal(box.repo, 'show', String(entry.item));
  assert.equal(shown.code, 0, shown.err);
  const lines = shown.out.split('\n').filter(line => line.startsWith('landing phase '));
  const { landing } = JSON.parse((await box.runLocal(box.repo, 'show', String(entry.item), '--json')).out);
  assert.deepEqual(lines, landing.phases.map(row => `landing phase ${row.phase}: ${row.ms} ms`));
});
