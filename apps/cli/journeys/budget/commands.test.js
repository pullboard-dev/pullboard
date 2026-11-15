/** @pullboard-world-pin: clause 0 reads packages/gate/data/ceilings/board-commands.json, the committed ceilings the audit lowers. */
/**
 * The main audit's board-command budget [C7]: a module count over its ratcheted ceiling or a median over 200 ms files
 * one board item naming the command, the value, the ceiling, the newly loaded modules and the commit range; a pass
 * lowers the ceilings. The measurement is faked here; packages/gate/src/io/matrix.js --only board-commands runs the real one.
 */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CHECK_EVERY_MS,
  SEAT_COMMANDS,
  WALL_MS,
  boardCommandBudgetCheck,
  budgetBreaches,
  effectiveCeilings,
  loweredCeilings,
} from '../../src/io/landing/budget.js';
import { HOPS } from '../../../../packages/gate/src/io/matrix.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

const CEILINGS = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../packages/gate/data/ceilings/board-commands.json'), 'utf8'));

/** A measurement of every seat command at the given module counts and medians. */
function measurement(modules, medianMs = 100) {
  return Object.fromEntries(Object.keys(SEAT_COMMANDS).map(name => [name, { modules: modules[name] ?? 10,
    loaded: Array.from({ length: modules[name] ?? 10 }, (_, index) => `src/m${index}.js`), medianMs: typeof medianMs === 'number' ? medianMs : medianMs[name] ?? 100 }]));
}

/** A board stand-in that answers the open-item lookup and records added items. */
function fakeBoard(open = null) {
  const added = [];
  return {
    added,
    read: action => action({ db: { prepare: () => ({ get: () => open }) } }),
    write: async (operation, args) => { assert.equal(operation, 'addItem'); added.push(args[0]); return 100 + added.length; },
  };
}

test('the committed ceilings name every seat command, and the hop matrix row runs this check [C7]', () => {
  assert.deepEqual(Object.keys(CEILINGS.modules).sort(), ['claim', 'inbox', 'next', 'show', 'status', 'whoami']);
  assert.deepEqual(Object.keys(SEAT_COMMANDS).sort(), Object.keys(CEILINGS.modules).sort());
  assert.equal(CEILINGS.wallMs, WALL_MS, 'the committed wall bar is the speed rule\'s');
  assert.equal(HOPS.find(hop => hop.id === 'command-latency').harness, 'board-commands');
});

test('clause 1: a module count over its ceiling breaches, naming the modules it newly loads; equal or under never does [C7]', () => {
  const ceilings = { next: 12, show: 10 };
  const measured = measurement({ next: 14, show: 10 });
  const breaches = budgetBreaches(measured, ceilings, { lastLoaded: { next: measured.next.loaded.slice(0, 12) } });
  assert.deepEqual(breaches, [{ command: 'next', kind: 'modules', value: 14, ceiling: 12, added: ['src/m12.js', 'src/m13.js'] }]);
  assert.deepEqual(budgetBreaches(measured, { next: 14, show: 10 }), []);
});

test('clause 2: a median over 200 ms breaches the wall bar [C7]', () => {
  const breaches = budgetBreaches(measurement({}, { status: 221 }), {});
  assert.deepEqual(breaches, [{ command: 'status', kind: 'wall', value: 221, ceiling: 200, added: [] }]);
});

test('clause 3: the audit record only lowers the committed ceilings, and a pass lowers them to what it measured [C7]', () => {
  assert.deepEqual(effectiveCeilings({ modules: { next: 20, show: 20 } }, { ceilings: { next: 15, show: 25 } }), { next: 15, show: 20 });
  assert.deepEqual(loweredCeilings({ next: 15, show: 20 }, measurement({ next: 12, show: 30 })), { next: 12, show: 20 });
});

test('clause 1: a breach files one item naming the command, value, ceiling, new modules and the commits since the last pass [C7]', async (t) => {
  const directory = privateFixtureFiles('pullboard-budget-audit-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let clock = 1_000_000;
  let counts = { next: 10 };
  const check = boardCommandBudgetCheck({ measure: async () => measurement(counts), now: () => clock });
  const board = fakeBoard();
  const first = await check({ directory, job: { tip: 'a'.repeat(40) }, lane: 'core', read: board.read, write: board.write });
  assert.deepEqual(first.breaches, []);
  const record = JSON.parse(readFileSync(join(directory, 'board-command-budget.json'), 'utf8'));
  assert.equal(record.lastPass.tip, 'a'.repeat(40));
  assert.equal(record.ceilings.next, 10, 'the pass lowered the next ceiling to the 10 modules it measured');
  assert.equal(await check({ directory, job: { tip: 'b'.repeat(40) }, lane: 'core', read: board.read, write: board.write }), null,
    'a drain within the check interval measures nothing');
  clock += CHECK_EVERY_MS + 1;
  counts = { next: 12 };
  const second = await check({ directory, job: { tip: 'c'.repeat(40) }, lane: 'core', read: board.read, write: board.write });
  assert.equal(second.breaches.length, 1);
  const [item] = board.added;
  assert.equal(item.lane, 'core');
  assert.match(item.title, /pullboard next module count/u);
  assert.match(item.criterion, /loads 12 modules in a fresh process, over its ceiling of 10/u);
  assert.match(item.criterion, new RegExp(`${'a'.repeat(12)}\\.\\.${'c'.repeat(12)}`, 'u'), 'the commit range since the last pass');
  assert.match(item.criterion, /newly loads: src\/m10\.js, src\/m11\.js/u);
  assert.equal(JSON.parse(readFileSync(join(directory, 'board-command-budget.json'), 'utf8')).lastPass.tip, 'a'.repeat(40), 'a breach keeps the last pass');
  clock += CHECK_EVERY_MS + 1;
  const held = fakeBoard({ item_id: 101 });
  const third = await check({ directory, job: { tip: 'd'.repeat(40) }, lane: 'core', read: held.read, write: held.write });
  assert.equal(third.breaches[0].filed, false);
  assert.deepEqual(held.added, [], 'an open repair for the same breach is never filed twice');
});
