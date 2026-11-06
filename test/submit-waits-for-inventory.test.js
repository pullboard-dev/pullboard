/** A gate waiting for a warming cells inventory waits for the producer instead of spending its infrastructure retries [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  acceptedCellsIdentity,
  waitForAcceptedCells,
} from '../packages/gate/index.js';
import { acceptedInventoryKey } from '../packages/codemap/index.js';
import { submitUntilSettled } from '../apps/lib/index.js';

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
  const ran = [];
  const settled = await submitUntilSettled(async attempt => {
    ran.push(attempt);
    if (ran.length === 1) throw pending();
    return 'green';
  }, {
    healthy: async () => true, wait: async () => {}, retries: 0,
    waitInventory: commit => waitForAcceptedCells('/unused', commit, { now: () => clock, sleep, read, owner: () => 'live', nudge: async () => assert.fail('a live owner is not nudged') }),
  });
  assert.equal(settled.result, 'green');
  assert.deepEqual(settled.attempts, [], 'no infrastructure attempt was counted');
  assert.deepEqual(ran, [1, 1], 'the same attempt number ran again');
  assert.deepEqual(sleeps, [15_000, 15_000]);
  assert.equal(polls, 3);
});

test('clause 2: a producer that died without publishing is nudged exactly once more before the wait gives up [C7]', async () => {
  const base = mkdtempSync(join(tmpdir(), 'wait-inventory-'));
  const home = join(base, 'home'), repo = join(base, 'repo');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try {
    mkdirSync(repo, { recursive: true });
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
    const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD');
    const identity = acceptedCellsIdentity(repo, commit);
    mkdirSync(identity.directory, { recursive: true });
    writeFileSync(join(identity.directory, `${acceptedInventoryKey(identity)}.owner.json`),
      JSON.stringify({ version: 1, pid: 2_147_483_646, started: null, token: 'dead', tree: identity.tree }));
    let clock = 0, nudges = 0;
    await assert.rejects(waitForAcceptedCells(repo, commit, {
      now: () => clock, sleep: async ms => { clock += ms; }, limitMs: 60_000,
      read: () => ({ available: false, cause: 'missing-artifact' }), nudge: async () => { nudges += 1; return null; },
    }), error => error.code === 'CELLS_INVENTORY_PENDING' && error.commit === commit);
    assert.equal(nudges, 1, 'exactly one re-nudge');
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(base, { recursive: true, force: true });
  }
});
