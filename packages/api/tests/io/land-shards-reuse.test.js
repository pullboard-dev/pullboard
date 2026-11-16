/** A land job's shards carry the items' own green gate rows first when the runner asks to reuse them; without the ask they carry today's list [C7,#9515]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { recordTestResults } from '../../../store/index.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { jobRequest } from '../../index.js';
import { offerJob } from '../../index.js';

const MAIN = 'a'.repeat(40), MERGED = 'b'.repeat(40), ITEM = 'e'.repeat(40), OTHER = 'd'.repeat(40), CONTEXT = 'c'.repeat(64);
const key = n => n.toString(16).padStart(64, '0');
const FILES = ['packages/x/tests/f1.test.js', 'packages/x/tests/f2.test.js', 'packages/x/tests/f3.test.js'];
const GATE = { run: ['node', '-e', 'x'], entry: 'gate.js', commits: [MAIN] };

/** A board where the item's gate proved f1 at key 1, then three newer runs elsewhere proved it at other keys; one claimed land job. */
function landing(t) {
  const board = cellBoard(t, ':memory:');
  const row = (file, inputKey) => ({ file, inputKey: key(inputKey), command: 'proof', context: CONTEXT, status: 'pass' });
  recordTestResults(board.db, { receipt: 'gate:item#0', origin: 'pulled:r-1', commit: ITEM, rows: [row(FILES[0], 1)] });
  for (const at of [2, 3, 4]) recordTestResults(board.db, { receipt: `gate:other-${at}#0`, origin: 'pulled:r-2', commit: OTHER, rows: [row(FILES[0], at)] });
  offerJob(board.db, { id: 'land:1:k', kind: 'land', base: MAIN, needs: [], now: 4 });
  const held = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 5 });
  const call = extra => boardJobQueueCall(board, { action: 'shards', job: 'land:1:k', runner: 'r-land', token: held.token, merged: MERGED,
    plan: { runner: 'node --test', files: FILES, cores: 1 }, gate: GATE, ...extra }, { mode: 'pull', now: 6 });
  /** The hit list of the shard that holds f1. */
  const hits = answer => {
    for (const id of answer.shards) {
      const claimed = claimJob(board.db, { runner: 'r-shard', capabilities: [], now: 8 });
      const request = jobRequest(board.db, { job: claimed.job, runner: 'r-shard', token: claimed.token }).request.input.data.shard;
      if (request.files.includes(FILES[0])) return (request.ledger?.files ?? []).map(([, inputKey]) => Number.parseInt(inputKey, 16));
    }
    return null;
  };
  return { call, hits };
}

test('clause 1: with reuseCommits the shard holding the item\'s file lists the item\'s own gate key first, before newer rows of other origins [C7,#9515]', t => {
  const { call, hits } = landing(t);
  assert.deepEqual(hits(call({ reuseCommits: [ITEM] })), [1, 4]);
});

test('clause 1: without reuseCommits the shards carry the newest rows only, as before [C7,#9515]', t => {
  const { call, hits } = landing(t);
  assert.deepEqual(hits(call()), [4, 3]);
});
