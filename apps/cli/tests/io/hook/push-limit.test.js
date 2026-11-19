/** The push gate's shard time limit is pushGate.shardMinutes, raised by the runner ceiling override [C7,#7810]. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SHARD_JOB_KIND } from '../../../../../packages/api/index.js';
import { claimJob } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { configFromSource } from '../../../../../packages/config/index.js';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { awaitAndWithdraw } from '../../../src/io/hook/push.js';
import { pushShardLimitMs } from '../../../src/io/hook/push.js';

const MIN = 60_000;
const JOBS = ['push:abc:tag:shard:1'];

/** Hold one shard on a runner of a temp board, then let `minutes` of fake time pass before the gate's next look. */
async function giveUp(t, ctx, minutes, env) {
  const clock = { at: 1_000_000 };
  const { db } = cellBoard(t, ':memory:');
  for (const id of JOBS) offerJob(db, { id, kind: SHARD_JOB_KIND, priority: 'gate', now: clock.at });
  claimJob(db, { runner: 'r1', now: clock.at, leaseMs: 600 * MIN });
  const on = work => work({ db });
  let polls = 0;
  const wait = async () => { clock.at += minutes * MIN; if (++polls > 2) throw new Error('never gave up'); };
  const limit = pushShardLimitMs(ctx.config, env);
  return awaitAndWithdraw(ctx, JOBS, { read: on, write: on, now: () => clock.at, wait, pollMs: 0, limitMs: limit, exit: () => assert.fail('no exit'), signals: new EventEmitter() });
}

test('cli.io-hook-push-limit.pushgate-shardminutes-defaults-to-20-is-read: clause 1: pushGate.shardMinutes defaults to 20, is read from pullboard.json, and a bad value is refused [C7,#7810]', () => {
  assert.equal(configFromSource('{}').pushGate.shardMinutes, 20);
  assert.equal(configFromSource('{"pushGate":{"shardMinutes":45}}').pushGate.shardMinutes, 45);
  for (const value of [0, -5, 1.5, '20', null, 5000]) assert.throws(() => configFromSource(JSON.stringify({ pushGate: { shardMinutes: value } })), { code: 'BAD_CONFIG' }, String(value));
  assert.equal(pushShardLimitMs({ pushGate: { shardMinutes: 45 } }, {}), 45 * MIN);
  assert.equal(pushShardLimitMs(undefined, {}), 20 * MIN, 'no config means the default');
});

test('cli.io-hook-push-limit.the-setting-sets-when-the-gate-gives: clause 1: the setting sets when the gate gives up, and the refusal names the setting and how to raise it [C7,#7810]', async t => {
  const settled = await giveUp(t, { config: { pushGate: { shardMinutes: 5 } } }, 6, {});
  assert.match(settled.refused, /ran past the 5-minute shard limit/u);
  assert.match(settled.refused, /raise pushGate\.shardMinutes in pullboard\.json/u);
  assert.match(settled.refused, /PULLBOARD_RUNNER_RUN_CEILING_MS/u);
  await assert.rejects(giveUp(t, { config: { pushGate: { shardMinutes: 30 } } }, 6, {}), /never gave up/u, 'a 6-minute look is inside a 30-minute limit');
});

test('cli.io-hook-push-limit.a-raised-pullboard-runner-run-ceiling-ms: clause 2: a raised PULLBOARD_RUNNER_RUN_CEILING_MS gives the same limit, and a lower or off one never shortens the setting [C7,#7810]', async t => {
  const config = { pushGate: { shardMinutes: 20 } };
  assert.equal(pushShardLimitMs(config, { PULLBOARD_RUNNER_RUN_CEILING_MS: String(60 * MIN) }), 60 * MIN);
  assert.equal(pushShardLimitMs(config, { PULLBOARD_RUNNER_RUN_CEILING_MS: String(5 * MIN) }), 20 * MIN);
  for (const off of ['0', '', 'soon']) assert.equal(pushShardLimitMs(config, { PULLBOARD_RUNNER_RUN_CEILING_MS: off }), 20 * MIN, `ceiling ${JSON.stringify(off)} adds nothing`);
  const env = { PULLBOARD_RUNNER_RUN_CEILING_MS: String(60 * MIN) };
  await assert.rejects(giveUp(t, { config }, 25, env), /never gave up/u, 'a 25-minute look is inside the raised 60-minute limit');
  const settled = await giveUp(t, { config }, 65, env);
  assert.match(settled.refused, /ran past the 60-minute shard limit/u);
});
