/** gate --withdraw shards --stale-before ends the offered shards of gates whose candidate lacks a main commit, through the real CLI on a pull board [C7,#12167]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { claimJob } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { itemThread } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

const FILES = ['web/a.test.js', 'web/b.test.js', 'web/c.test.js', 'web/d.test.js'];
const PROOF = `node --test ${FILES.map(file => `'./${file}'`).join(' ')}`;
const ENVIRONMENT = { node: process.version, platform: process.platform, arch: process.arch };
const CAPABILITIES = ['node22'];

/**
 * One pulled item submitted through the real CLI, its gate job passed its check and left its proof to four offered
 * shards through the board's job queue, one shard taken by a runner, then a main commit the candidate lacks.
 */
async function shardedGate(t) {
  const box = await pullProject(t, 1, { gate: { runnerDispatch: 'pull' } });
  const [id] = box.ids;
  const sent = submitOne(box, id);
  const { board } = await pullQueue(t, box);
  const lease = claimJob(board.db, { runner: 'runner-g', capabilities: CAPABILITIES });
  assert.ok(lease, 'a runner takes the offered gate job');
  const candidate = jobsOf(board.db, { kind: 'gate', item: id }).at(-1).candidate;
  const gate = { version: 1, source: candidate, green: false, environment: ENVIRONMENT, phases: [{ role: 'check', status: 0 }], analysis: { proofFiles: FILES, proofCommand: PROOF },
    proofPlan: { runner: 'node --test', cores: 1, files: FILES } };
  const posted = boardJobQueueCall(board, { action: 'receipt', job: lease.job, runner: 'runner-g', token: lease.token, receipt: { status: 0, gate } }, { mode: 'pull' });
  assert.equal(posted.applied?.outcome, 'sharded', JSON.stringify(posted.applied));
  const shards = posted.applied.shards;
  const taken = claimJob(board.db, { runner: 'runner-s', capabilities: CAPABILITIES });
  assert.ok(shards.includes(taken?.job), 'a runner holds one shard');
  box.git(box.repo, 'commit', '--allow-empty', '-q', '-m', 'fix(web): the main fix [G1]');
  const fix = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  return { box, id, sent, board, gate: lease.job, candidate, fix, claimed: taken.job, offered: shards.filter(job => job !== taken.job) };
}

/** The step of each named job, read from the board host's connection. */
const steps = (board, ids) => ids.map(id => jobView(board.db, id).step);

test('cli.journeys-gate-withdraw-stale.dry-run-then-end: clause 1: gate --withdraw shards --stale-before lists with --dry-run and ends nothing, then ends the offered shards of the stale gate and leaves the claimed one [C7,#12167]', async t => {
  const { box, id, board, gate, candidate, fix, claimed, offered } = await shardedGate(t);
  const dry = await box.runIn(box.repo, 'gate', '--withdraw', 'shards', '--stale-before', fix, '--dry-run');
  assert.equal(dry.code, 0, `${dry.err}\n${dry.out}`);
  assert.match(dry.out, new RegExp(`#${id} ${gate} at ${candidate.slice(0, 12)}: would end ${offered.length} offered shard\\(s\\)`, 'u'), dry.out);
  assert.match(dry.out, new RegExp(`dry run: would end ${offered.length} offered shard\\(s\\) of 1 gate\\(s\\) whose candidate lacks ${fix.slice(0, 12)}`, 'u'), dry.out);
  assert.deepEqual(steps(board, offered), offered.map(() => 'offered'), 'the dry run ended nothing');
  const out = await box.runIn(box.repo, 'gate', '--withdraw', 'shards', '--stale-before', fix, '--json');
  assert.equal(out.code, 0, `${out.err}\n${out.out}`);
  const document = JSON.parse(out.out);
  assert.equal(document.ended, offered.length);
  assert.deepEqual(document.gates.map(one => [one.item, one.gate, one.shards]), [[id, gate, offered]]);
  assert.deepEqual(steps(board, offered), offered.map(() => 'done'), 'the offered shards ended');
  assert.deepEqual(steps(board, [claimed]), ['claimed'], 'the claimed shard runs on');
});

test('cli.journeys-gate-withdraw-stale.item-fact-names-next: clause 2: the item gets one note naming the gate job, the shards ended, the missing commit and the next step [C7,#12167]', async t => {
  const { box, id, board, gate, fix, offered } = await shardedGate(t);
  const out = await box.runIn(box.repo, 'gate', '--withdraw', 'shards', '--stale-before', fix);
  assert.equal(out.code, 0, `${out.err}\n${out.out}`);
  const notes = itemThread(board, id).map(fact => fact.text ?? '').filter(text => text.startsWith(`Gate job ${gate}: the coordinator ended`));
  assert.equal(notes.length, 1, notes.join(' | '));
  assert.match(notes[0], new RegExp(`ended ${offered.length} offered shard\\(s\\)`, 'u'));
  assert.match(notes[0], new RegExp(`does not contain main commit ${fix.slice(0, 12)}`, 'u'));
  assert.match(notes[0], /Next: merge main and submit again\./u);
});

test('cli.journeys-gate-withdraw-stale.refusals: clause 2: a builder seat is refused, and --stale-before or --withdraw shards alone refuse USAGE; nothing ends [C7,#12167]', async t => {
  const { box, board, sent, fix, offered } = await shardedGate(t);
  const seat = await box.runIn(sent.folder, 'gate', '--withdraw', 'shards', '--stale-before', fix);
  assert.notEqual(seat.code, 0, 'a builder seat cannot end other gates\' shards');
  assert.match(seat.out + seat.err, /coordinator/u);
  const alone = await box.runIn(box.repo, 'gate', '--stale-before', fix);
  assert.notEqual(alone.code, 0);
  assert.match(alone.out + alone.err, /USAGE/u);
  const bare = await box.runIn(box.repo, 'gate', '--withdraw', 'shards');
  assert.notEqual(bare.code, 0);
  assert.match(bare.out + bare.err, /USAGE/u);
  assert.deepEqual(steps(board, offered), offered.map(() => 'offered'), 'nothing ended');
});
