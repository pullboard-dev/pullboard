/** Drives the real CLI (add, whoami, claim, release, show --json, machine pricing settings) with synthetic numeric usage and checks local dollar pricing end to end [N2]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const prices = {
  alpha: { freshInput: 2, cacheReadInput: 1, cacheWriteInput: 3, output: 4 },
  beta: { freshInput: 5, cacheReadInput: 5, cacheWriteInput: 5, output: 10 },
};

/** One sanitized numeric model row; the counts are hand-chosen fixture inputs. */
function usage(model, fresh = 100_000, read = 200_000, write = 50_000, output = 25_000) {
  return { model, inputTokens: fresh + read + write, knownInputTokens: fresh + read + write,
    outputTokens: output, knownOutputTokens: output, freshInputTokens: fresh,
    cacheReadInputTokens: read, cacheWriteInputTokens: write, wallMs: 7, unknownReasons: [] };
}

/** Require a successful real CLI document. */
function document(result) {
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

test('local prices compute two models by hand while an unpriced model retains tokens and unknown dollars [N2]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const ids = await Promise.all(['alpha', 'beta', 'unpriced', 'mixed', 'shared'].map(async model => document((await fixtureAdd(box.runLocal, box.repo, 'web', `Pricing ${model}`,
    '--criterion', 'Local dollars preserve numeric usage.', '--specs', 'G1', '--check', 'test -f web/ready', '--json'))).item.item_id));
  const agent = document((await box.runLocal(box.web, 'whoami', '--json'))).id;
  for (const id of ids) {
    document((await box.runLocal(box.web, 'claim', String(id), '--json')));
    document((await box.runLocal(box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'Close the pricing fixture claim.', '--no-next', '--json')));
  }
  // @pullboard-board-file journey: real CLI seats share this isolated board; supported recordUsage supplies synthetic numeric input.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let before;
  try {
    ids.forEach((item, index) => store.recordUsage(board, { agentId: agent, item, revision: 100, observedAt: 1,
      shared: index === 4, records: index === 3 ? [usage('alpha'), usage('beta')] : [usage(['alpha', 'beta', 'unpriced', 'mixed', 'alpha'][index])] }));
    before = store.events(board);
  } finally { store.closeBoard(board); }
  const noPrices = document((await box.runLocal(box.repo, 'show', String(ids[0]), '--json'))).usage;
  assert.equal(Object.hasOwn(noPrices, 'costUSD'), false);
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeFileSync(file, JSON.stringify({ ...previous, costPrices: prices }));
  // alpha: .1*2 + .2*1 + .05*3 + .025*4 = .65 USD.
  // beta: .35*5 + .025*10 = 2 USD.
  for (const [index, expected] of [[0, .65], [1, 2], [2, null]]) {
    const shown = document((await box.runLocal(box.repo, 'show', String(ids[index]), '--json'))).usage;
    assert.equal(shown.costUSD, expected);
    assert.equal(shown.inputTokens, 350_000);
    assert.match((await box.runLocal(box.repo, 'show', String(ids[index]))).out, new RegExp(`cost USD ${expected === null ? 'unknown' : expected.toFixed(6)}`, 'u'));
  }
  const stats = document((await box.runLocal(box.repo, 'stats', '--json'))).usage;
  assert.equal(stats.items.find(row => row.item === ids[0]).costUSD, .65);
  assert.equal(stats.models.find(row => row.model === 'beta').costUSD, 4);
  assert.equal(stats.models.find(row => row.model === 'unpriced').costUSD, null);
  assert.equal(stats.lanes.find(row => row.lane === 'web').costUSD, null);
  assert.equal(stats.items.find(row => row.item === ids[3]).costUSD, 2.65, 'mixed models are priced before their tokens are aggregated');
  assert.equal(document((await box.runLocal(box.repo, 'show', String(ids[3]), '--json'))).usage.costUSD, 2.65);
  assert.equal(stats.items.find(row => row.item === ids[4]).costUSD, null, 'shared allocation is not charged to an individual item');
  assert.equal(document((await box.runLocal(box.repo, 'show', String(ids[4]), '--json'))).usage.costUSD, null);
  assert.ok(Math.abs(stats.lanes.find(row => row.lane === 'web').knownCostUSD - 5.3) < 1e-12,
    'the two alpha and two beta allocations total 5.30 USD within floating-point rounding');
  assert.match((await box.runLocal(box.repo, 'stats')).out, /cost USD 0\.650000/u);
  assert.equal(JSON.stringify(stats).includes('costPrices'), false);
  writeFileSync(file, JSON.stringify({ ...previous, costPrices: { alpha: { output: -1 } } }));
  const invalid = (await box.runLocal(box.repo, 'show', String(ids[0]), '--json'));
  assert.notEqual(invalid.code, 0);
  assert.equal(JSON.parse(invalid.out).error.code, 'BAD_MACHINE_SETTINGS');
  writeFileSync(file, JSON.stringify({ ...previous, costPrices: prices }));
  // @pullboard-board-file journey: pricing reads must not publish local rates, dollars, or accounting events.
  const after = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.deepEqual(store.events(after), before);
    assert.equal(JSON.stringify(store.events(after)).includes('costUSD'), false);
    assert.equal(JSON.stringify(store.events(after)).includes('costPrices'), false);
  } finally { store.closeBoard(after); }
});

