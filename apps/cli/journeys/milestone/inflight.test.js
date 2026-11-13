/** Item labels are computed from the item, never typed, and grant nothing [N2,B13]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/index.js';
import { itemLabels } from '../../../../packages/queue/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('automatic labels appear without config [N2,B13]', () => {
  const labels = itemLabels({ item_lane: 'core', item_level: 'L2', item_review_tier: 'strict', item_expected_build_minutes: 5 }, { brokenMain: true });
  assert.deepEqual(labels, ['broken-main', 'lane:core', 'level:L2', 'quick-win', 'review:strict']);
  assert.deepEqual(itemLabels({ item_lane: 'view', item_review_tier: 'standard', item_expected_build_minutes: 30 }), ['lane:view']);
});

test('a hand label is kept and the list is sorted [N2,B13]', () => {
  assert.deepEqual(itemLabels({ item_lane: 'core', item_labels: ['zeta', 'alpha', 'alpha'] }), ['alpha', 'lane:core', 'zeta']);
});

test('labels never grant or deny an agent: a typed automatic name is dropped and the item is untouched [N2,B13]', () => {
  const item = Object.freeze({ item_lane: 'core', item_review_tier: 'standard', item_labels: Object.freeze(['review:strict', 'broken-main', 'lane:other', 'quick-win']) });
  assert.deepEqual(itemLabels(item), ['lane:core']);
  assert.deepEqual(item.item_labels, ['review:strict', 'broken-main', 'lane:other', 'quick-win']);
});

/** A project declaring label bounds, with one web item claimed and one open. */
function labelled(labels) {
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, labels } });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: declare labels [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const file = title => fileFixtureItem(box, box.repo, { lane: 'web', title, criterion: 'the page renders', check: 'true', args: ['--specs', 'G1'] }).item_id;
  return { box, claimed: file('Claimed page'), open: file('Open page') };
}

test('clause 1: labels lists each label with min, max, holders and unmet minimums, in text and --json [N2,B13]', async () => {
  const { box, claimed } = labelled({ 'lane:web': { min: 1, max: 3 }, 'lane:api': { min: 2 }, 'quick-win': {} });
  assert.equal((await box.runLocal(box.web, 'claim', String(claimed))).code, 0);
  const text = await box.runLocal(box.web, 'labels');
  assert.equal(text.code, 0, `${text.out}\n${text.err}`);
  assert.match(text.out, /^lane:api {2}min 2 {2}max - {2}holders 0: none {2}UNMET MINIMUM$/mu);
  assert.match(text.out, /^lane:web {2}min 1 {2}max 3 {2}holders 1: \S+$/mu);
  assert.doesNotMatch(text.out.split('\n').find(line => line.startsWith('lane:web')), /UNMET/u);
  const json = JSON.parse((await box.runLocal(box.web, 'labels', '--json')).out);
  const row = name => json.labels.find(entry => entry.label === name);
  assert.deepEqual(json.unmet, ['lane:api']);
  assert.deepEqual([row('lane:web').min, row('lane:web').max, row('lane:web').holders.length, row('lane:web').unmet], [1, 3, 1, false]);
  assert.deepEqual([row('lane:api').min, row('lane:api').max, row('lane:api').holders, row('lane:api').unmet], [2, null, [], true]);
  assert.deepEqual([row('quick-win').min, row('quick-win').max, row('quick-win').unmet], [null, null, false]);
  assert.equal(typeof json.version, 'number');
});

test('clause 1: a bad min or max is refused with the fix [N2,B13]', () => {
  const refusal = (labels, pattern) => assert.throws(() => configFromSource(JSON.stringify({ name: 'x', labels })), error => error.code === 'BAD_CONFIG' && pattern.test(error.message));
  refusal({ a: { min: 3, max: 1 } }, /min 3 above max 1; lower the min or raise the max/u);
  refusal({ a: { min: -1 } }, /labels\.a\.min" is a whole number of 0 or more/u);
  refusal({ a: { max: 1.5 } }, /labels\.a\.max" is a whole number/u);
  refusal({ a: { most: 2 } }, /has only "min" and "max"/u);
  refusal([], /is an object/u);
});
