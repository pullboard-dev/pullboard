/** Drives the real CLI (fact, sentinel run, milestone add and ship) and checks the time facts and checkpoints it records end to end [R1,R2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TIME_PHASES,
  timeStats,
} from '../../../../packages/stats/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const MIN = 60000;
const NOW = T0 + 200 * MIN;
let id = 0;
/** One native event at a known minute offset. */
const ev = (item, minute, kind, detail = {}) => ({ event_id: ++id, item_id: item, event_kind: kind, event_at: new Date(T0 + minute * MIN).toISOString(), event_detail: JSON.stringify(detail) });

test('native measurement facts split tool and thinking from building [R1,R2,C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  const added = fixtureAdd(box.run, box.repo, 'web', 'Measured build', '--specs', 'G1', '--route', 'strong', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const item = JSON.parse(added.out).item.item_id;
  const text = JSON.stringify({ kind: 'seat-time', toolMs: 4 * MIN, thinkingMs: 2 * MIN });
  const recorded = box.run(box.repo, 'fact', String(item), 'measurement', text, '--json');
  assert.equal(recorded.code, 0, recorded.err || recorded.out);
  const fact = JSON.parse(recorded.out).fact;
  assert.equal(fact.kind, 'measurement');
  assert.equal(fact.text, text);
  const history = [ev(item, 0, 'add'), ev(item, 10, 'claim'), ev(item, 15, 'fact', fact),
    ev(item, 40, 'submit'), ev(item, 50, 'accept'), ev(item, 60, 'merged')];
  const row = timeStats(history, { now: NOW }).items[0];
  assert.equal(row.phases.tool / MIN, 4);
  assert.equal(row.phases.thinking / MIN, 2);
  assert.equal(row.phases.building / MIN, 24);
  assert.equal(TIME_PHASES.reduce((sum, phase) => sum + row.phases[phase], 0), row.clockMs);
});

test('coordinator sentinel and milestone ship record their checkpoints [R1,R2,C7]', t => {
  const previousModel = process.env.PULLBOARD_MODEL;
  process.env.PULLBOARD_MODEL = 'fixture-model';
  t.after(() => { if (previousModel === undefined) delete process.env.PULLBOARD_MODEL; else process.env.PULLBOARD_MODEL = previousModel; });
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const run = (...args) => {
    const result = box.run(box.repo, ...args);
    assert.equal(result.code, 0, result.err || result.out);
  };
  run('sentinel', 'run', '--health-only');
  run('sentinel', 'run', '--health-only');
  run('milestone', 'add', 'release-test');
  run('milestone', 'ship', 'release-test');
  const file = join(box.repo, '.git', 'pullboard', 'stats-history.jsonl');
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.reason), ['weekly', 'release']);
  assert.equal(rows[1].label, 'release-test');
});
