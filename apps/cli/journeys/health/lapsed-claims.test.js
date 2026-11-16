/** The sentinel expires a claim whose lease lapsed within two minutes, with no command run, behind health.lapsedSweep [C7,#8923]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sweepLapsedClaims } from '../../../../packages/health/index.js';
import { startServeSentinel } from '../../../../packages/sentinels/index.js';
import { LAPSED_SWEEP_INTERVAL_MS } from '../../../../packages/sentinels/src/io/serve.js';
import { lapsedSweepEnabled } from '../../../../packages/config/index.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

/** A started serve sentinel whose timers are captured, so the test fires each tick itself. */
function served({ lapsedOn }) {
  const ticks = new Map();
  const runs = [];
  const sentinel = startServeSentinel({ projectRoot: '/project', cli: 'cli.js', projects: () => [], enabled: () => true,
    every: () => 0, cancel: () => {}, liveEvery: (fn, ms) => { ticks.set(ms, fn); return { unref() {} }; }, liveCancel: () => {},
    canary: () => ({ close: async () => {} }), run: async (root, signal, words) => { runs.push(words); },
    audit: async () => {}, lapsedOn });
  return { ticks, runs, sentinel };
}

test('clause 1: the sentinel runs a lapsed-claim pass at least every minute, so a lapsed lease is expired within 2 minutes [C7,#8923]', async () => {
  const { ticks, runs, sentinel } = served({ lapsedOn: () => true });
  assert.ok(LAPSED_SWEEP_INTERVAL_MS * 2 <= 120_000, 'a lapse waits at most one interval for the pass and one to finish it');
  await ticks.get(LAPSED_SWEEP_INTERVAL_MS)();
  assert.deepEqual(runs, [['sentinel', 'run', '--lapsed-only', '--json']]);
  await sentinel.close();
});

test('clause 1: with health.lapsedSweep off the sentinel runs no lapsed-claim pass [C7,#8923]', async () => {
  const { ticks, runs, sentinel } = served({ lapsedOn: () => false });
  await ticks.get(LAPSED_SWEEP_INTERVAL_MS)();
  assert.deepEqual(runs, []);
  await sentinel.close();
});

test('clause 1: health.lapsedSweep is off on an empty machine home [C7,#8923]', () => {
  const home = privateFixtureFiles('pullboard-lapsed-sweep-').root;
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { assert.equal(lapsedSweepEnabled(), false); }
  finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
});

test('clause 1: a lapsed-claim pass moves only the claims the capture names, as one ordered stale-state move [C7,#8923]', async () => {
  const moves = [];
  const snapshot = { claims: [{ id: 41 }] };
  const ordered = async (ctx, board, operation, args) => { moves.push({ operation, args }); };
  const ctx = { io: {}, config: {} };
  const seen = [];
  const result = await sweepLapsedClaims(ctx, {}, 'sentinel-seat', ordered, { captureLapsedClaims: (c, b, actor, options) => { seen.push(options); return snapshot; } });
  assert.equal(result, snapshot);
  assert.deepEqual(seen, [{ lapsedOnly: true }], 'the capture reads board rows only, no Git');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].operation, 'maintainStaleState');
  assert.equal(moves[0].args[0].claimsOnly, true);
  assert.equal(moves[0].args[0].snapshot, snapshot);
  const idle = await sweepLapsedClaims(ctx, {}, 'sentinel-seat', ordered, { captureLapsedClaims: () => null });
  assert.equal(idle, null);
  assert.equal(moves.length, 1, 'no lapsed claim, no move');
});
