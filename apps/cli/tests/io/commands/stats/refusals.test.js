/** @pullboard-test-input source-cell apps/cli */
/** `pullboard stats refusals` counts the refusals recorded in the trace by code, with seat and item [C7,#12045]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../../packages/gate/tests/fixtures/child.js';
import { runRefusals } from '../../../../src/io/commands/stats/refusals.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const ctxOf = commonDir => ({ info: { commonDir }, clock: { now: () => new Date(NOW) } });
const refused = (code, agent, item, at = '2026-11-20T10:00:00.000Z') => ({ at, agent, item, command: 'submit', exit: 1, refusal: { code, message: 'no' } });
const ok = (agent, item) => ({ at: '2026-11-20T10:30:00.000Z', agent, item, command: 'next', exit: 0, refusal: null });

/** A scratch common dir holding one trace file of the given lines. */
function withTrace(lines, run) {
  const files = privateFixtureFiles('pb-refusals-');
  files.write('pullboard/trace/2026-11-20.jsonl', `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return run(files.root);
}

/** Run the command over a trace and return its exit code, printed lines and JSON result. */
function go(dir, values) {
  const out = []; let result = null;
  const code = runRefusals({ say: line => out.push(line), result: value => { result = value; } }, ctxOf(dir), { second: undefined, rest: [], values });
  return { code, out, result };
}

const LINES = [
  ...Array.from({ length: 4 }, (_, n) => refused('NOT_YOURS', n < 3 ? 'core-1' : 'core-2', n < 2 ? 11 : 12)),
  refused('NOT_YOURS', 'core-1', 11, '2026-11-18T10:00:00.000Z'),
  ...Array.from({ length: 3 }, () => refused('USAGE', 'core-2', 13)),
  refused('STALE_HEAD', 'core-1', 12),
  ok('core-1', 11), ok('core-1', 12), ok('core-2', 13), ok('core-2', null),
];

test('cli.io-commands-stats-refusals.counts-by-code: clause 1: from a trace of 12 lines (3 codes across 2 seats and 3 items plus 4 ok lines) stats refusals prints the three codes with counts 5, 3, 1 highest first with their top seats and items, --since 24h drops older lines, and --json carries the same rows [C7]', () => {
  withTrace(LINES, dir => {
    const all = go(dir, {});
    assert.equal(all.code, 0);
    assert.deepEqual(all.out.slice(0, 3), ['NOT_YOURS: 5', 'USAGE: 3', 'STALE_HEAD: 1']);
    assert.ok(all.out.includes('NOT_YOURS seats: core-1 4, core-2 1'));
    assert.ok(all.out.includes('NOT_YOURS items: #11 3, #12 2'));
    assert.ok(all.out.includes('USAGE seats: core-2 3'));
    assert.ok(all.out.includes('USAGE items: #13 3'));
    assert.deepEqual(all.result.refusals.map(row => [row.code, row.count]), [['NOT_YOURS', 5], ['USAGE', 3], ['STALE_HEAD', 1]]);
    const recent = go(dir, { since: '24h' });
    assert.deepEqual(recent.out.slice(0, 3), ['NOT_YOURS: 4', 'USAGE: 3', 'STALE_HEAD: 1']);
    assert.deepEqual(recent.result.refusals, go(dir, { since: '24h', json: true }).result.refusals);
  });
});

test('cli.io-commands-stats-refusals.refuses-a-bad-since: clause 1: a --since that is not <number><s|m|h|d> refuses USAGE and an empty trace prints that nothing was recorded [C7]', () => {
  withTrace([ok('core-1', 1)], dir => {
    assert.throws(() => go(dir, { since: 'soon' }), { code: 'USAGE' });
    assert.deepEqual(go(dir, {}).out, ['no refusals recorded']);
  });
});
