/** A gate waiting for a warming cells inventory waits for the producer instead of spending its infrastructure retries [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../cli/tests/fixtures/child.js';
import {
  acceptedCellsIdentity,
  waitForAcceptedCells,
} from '../../../../../../packages/gate/index.js';
import { acceptedInventoryKey } from '../../../../../../packages/codemap/index.js';
import { submitUntilSettled } from '../../../../index.js';

const COMMIT = 'a'.repeat(40);

/** A pending refusal as submitCellsInventory throws it, carrying the commit. */
function pending(commit = COMMIT) {
  return Object.assign(new Error('accepted cells inventory is warming'), { code: 'CELLS_INVENTORY_PENDING', retryable: true, commit });
}

test('clause 1: a pending inventory that turns ready after two polls is waited for and no attempt is counted [C7]', async () => {
  let clock = 0, polls = 0;
  const sleeps = [];
  const read = () => ({ available: ++polls > 2, cause: 'missing-artifact' });
  const sleep = async ms => { sleeps.push(ms); clock += ms; };
  const ran = [], beats = [];
  const settled = await submitUntilSettled(async attempt => {
    ran.push(attempt);
    if (ran.length === 1) throw pending();
    return 'green';
  }, {
    healthy: async () => true, wait: async () => {}, retries: 0,
    waitInventory: commit => waitForAcceptedCells('/unused', commit, { now: () => clock, sleep, read, beat: line => beats.push(line), owner: () => 'live', nudge: async () => assert.fail('a live owner is not nudged') }),
  });
  assert.equal(settled.result, 'green');
  assert.deepEqual(settled.attempts, [], 'no infrastructure attempt was counted');
  assert.deepEqual(ran, [1, 1], 'the same attempt number ran again');
  assert.deepEqual(sleeps, [15_000, 15_000]);
  assert.equal(polls, 3);
  assert.equal(beats.length, 2, 'each poll of the live producer leaves a heartbeat line');
  assert.match(beats[1], /waited 30 s of 900 s/u);
});

test('clause 1: a cells-check stop naming inventoryCommit, as the runner reports it, waits instead of spending a retry [C7]', async () => {
  let polls = 0;
  const waitedFor = [], ran = [];
  const settled = await submitUntilSettled(async attempt => {
    ran.push(attempt);
    if (ran.length === 1) throw Object.assign(new Error('accepted cells inventory is not ready'), { code: 'CELLS_INVENTORY_PENDING', retryable: true, inventoryCommit: COMMIT });
    return 'green';
  }, {
    healthy: async () => true, wait: async () => {}, retries: 0,
    waitInventory: commit => { waitedFor.push(commit); return waitForAcceptedCells('/unused', commit, { now: () => 0, sleep: async () => {}, owner: () => 'live',
      read: () => ({ available: ++polls > 1, cause: 'missing-artifact' }) }); },
  });
  assert.equal(settled.result, 'green');
  assert.deepEqual(waitedFor, [COMMIT]);
  assert.deepEqual(settled.attempts, []);
});

test('clause 1: an inventory already ready on the first poll counts the stop, so a check that stays pending still ends [C7]', async () => {
  let runs = 0;
  await assert.rejects(submitUntilSettled(async () => { runs += 1; throw pending(); }, {
    healthy: async () => true, wait: async () => {}, retries: 1,
    waitInventory: commit => waitForAcceptedCells('/unused', commit, { read: () => ({ available: true }), owner: () => 'live' }),
  }), error => error.code === 'GATE_INFRA_EXHAUSTED');
  assert.equal(runs, 2, 'each pending stop spent one attempt');
});

test('clause 2: a producer that died without publishing is nudged exactly once more before the wait gives up [C7]', async () => {
  const base = privateFixtureFiles('wait-inventory-').root;
  const home = join(base, 'home'), repo = join(base, 'repo');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try {
    mkdirSync(repo, { recursive: true });
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
    const inRepo = (...args) => runFixtureGit(args, { cwd: repo, env });
    inRepo('init', '--quiet');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    inRepo('add', '.');
    inRepo('commit', '--quiet', '-m', 'fixture');
    const commit = inRepo('rev-parse', 'HEAD');
    const identity = acceptedCellsIdentity(repo, commit, { pinned: true });
    mkdirSync(identity.directory, { recursive: true });
    writeFileSync(join(identity.directory, `${acceptedInventoryKey(identity)}.owner.json`),
      JSON.stringify({ version: 1, pid: 2_147_483_646, started: null, token: 'dead', tree: identity.tree }));
    let clock = 0, nudges = 0, sleeps = 0;
    await assert.rejects(waitForAcceptedCells(repo, commit, {
      now: () => clock, sleep: async ms => { sleeps += 1; clock += ms; }, limitMs: 60_000,
      read: () => ({ available: false, cause: 'missing-artifact' }), nudge: async () => { nudges += 1; return null; },
    }), error => error.code === 'CELLS_INVENTORY_PENDING' && error.commit === commit && /no live producer/u.test(error.message));
    assert.equal(nudges, 1, 'exactly one re-nudge');
    assert.equal(sleeps, 0, 'a dead producer ends the wait at once instead of sleeping out the deadline');
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(base, { recursive: true, force: true });
  }
});

test('clause 2: a dead producer re-nudged into a live one is waited on until it publishes [C7]', async () => {
  let live = false, polls = 0, nudges = 0;
  const found = await waitForAcceptedCells('/unused', COMMIT, { now: () => 0, sleep: async () => {},
    owner: () => (live ? 'live' : 'dead'), nudge: async () => { nudges += 1; live = true; },
    read: () => ({ available: ++polls > 3, cause: 'missing-artifact' }) });
  assert.equal(found.available, true);
  assert.equal(nudges, 1);
  assert.equal(found.waited, 3);
});
