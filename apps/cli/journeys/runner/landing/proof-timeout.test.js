/**
 * A landing check that runs past its deadline has its process tree stopped and posts LAND_PROOF_TIMEOUT, and the board
 * offers the landing again up to a bound, then the coordinator hears the named refusal; renewals no longer keep a hung
 * proof's lease alive forever [C7,#7820].
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { jobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { applyLandingReceipt } from '../../../../../packages/api/index.js';
import { runLandingJob } from '../../../../../packages/landing/index.js';
import { addItem } from '../../../../../packages/store/index.js';
import { register } from '../../../../../packages/store/index.js';
import { claim } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { verify } from '../../../../../packages/store/index.js';
import { itemThread } from '../../../../../packages/store/index.js';
import { proofLimitMs } from '../../../../../packages/landing/src/io/runner/deadline.js';
import { ledgerProofCheck } from '../../../../../packages/landing/src/io/runner/proof.js';
import { waitForState } from '../../../tests/fixtures/check-baseline.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { FIXTURE_MODEL } from '../../../tests/fixtures/testkit.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];

/** Whether a process is still alive. */
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };


/** A board with one accepted item, whose commit is the fixture repo's head. */
function accepted(t) {
  const graph = fixtureCommittedGraph('pullboard-proof-timeout-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put('package.json', '{ "type": "module" }\n');
  graph.put('pullboard.json', '{ "lanes": {} }\n');
  const sha = graph.commit();
  const board = cellBoard(t, ':memory:', undefined, { gitRoot: graph.root });
  register(board, { lane: 'coordinator', path: graph.root, route: 'strong', model: FIXTURE_MODEL });
  const actor = register(board, { lane: 'core', path: join(graph.root, 'b'), route: 'strong', model: FIXTURE_MODEL });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Item', criterion: 'The item lands.' });
  const frozen = JSON.stringify({ criterion: 'The item lands.' });
  const digest = createHash('sha256').update(frozen).digest('hex');
  claim(board, id, { agentId: actor, lane: 'core', leaseMs: 3_600_000, head: sha, freeze: () => ({ text: frozen, digest }) });
  submitFixture(board, id, { agentId: actor, commit: sha, tree: git(graph.root, ['rev-parse', `${sha}^{tree}`]) });
  verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'fixture acceptance', head: sha, digest, policy: 'any' });
  return { board, id, sha };
}

test('clause 1: the landing check limit is the push shard limit by default, raised by a longer runner ceiling and off at 0 [C7,#7820]', () => {
  assert.equal(proofLimitMs({}, {}), 20 * 60_000);
  assert.equal(proofLimitMs({ proofMinutes: 45 }, {}), 45 * 60_000);
  assert.equal(proofLimitMs({ proofMinutes: 45 }, { PULLBOARD_RUNNER_RUN_CEILING_MS: String(90 * 60_000) }), 90 * 60_000);
  assert.equal(proofLimitMs({ proofMinutes: 45 }, { PULLBOARD_RUNNER_RUN_CEILING_MS: '60000' }), 45 * 60_000);
  assert.equal(proofLimitMs({}, { PULLBOARD_RUNNER_RUN_CEILING_MS: '0' }), null);
});

test('clause 1: a ledger proof past its deadline stops its whole process tree and returns a timeout, not a red [C7,#7820]', async t => {
  const { root } = privateFixtureFiles('pullboard-proof-hang-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A stub runner: a shell that starts a grandchild and then waits for it, like run-tests above a test file.
  writeFileSync(join(root, 'hang.sh'), `sleep 300 &\necho $! > grandchild.pid\nwait\n`);
  const proof = ledgerProofCheck({ runner: 'sh', files: ['hang.sh'], ledger: null }, { deadline: () => ({ at: Date.now() + 600, ms: 600 }) });
  const result = await proof({ root });
  assert.equal(result.ok, false);
  assert.equal(result.timeout, true);
  assert.match(result.detail, /^LAND_PROOF_TIMEOUT: the landing proof \(1 files, 0 reused so far\) ran past the landing's/u);
  await waitForState(() => existsSync(join(root, 'grandchild.pid')), 'the stub proof started its grandchild');
  const pid = Number(readFileSync(join(root, 'grandchild.pid'), 'utf8'));
  await waitForState(() => !alive(pid), `the proof's grandchild ${pid} is stopped with its tree`);
});

test('clause 1: a proof that ends before its deadline is judged as before, and a deadline of null never fires [C7,#7820]', async t => {
  const { root } = privateFixtureFiles('pullboard-proof-fast-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'ok.sh'), 'exit 0\n');
  writeFileSync(join(root, 'bad.sh'), 'exit 3\n');
  const green = await ledgerProofCheck({ runner: 'sh', files: ['ok.sh'], ledger: null }, { deadline: () => ({ at: Date.now() + 60_000, ms: 60_000 }) })({ root });
  assert.deepEqual([green.ok, green.timeout], [true, undefined]);
  const red = await ledgerProofCheck({ runner: 'sh', files: ['bad.sh'], ledger: null }, { deadline: () => null })({ root });
  assert.deepEqual([red.ok, red.timeout], [false, undefined]);
  assert.match(red.detail, /landing proof exited 3/u);
});

test('clause 1: a land job whose check runs past its deadline posts proof-timeout with nothing returned or pushed [C7,#7820]', async t => {
  const { root } = privateFixtureFiles('pullboard-landing-timeout-');
  const dev = fixtureCommittedGraph('pullboard-landing-timeout-dev-').root;
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(dev, { recursive: true, force: true }); });
  const commit = (file, text, message) => { writeFileSync(join(dev, file), text); git(dev, ['add', file]); git(dev, [...AS, 'commit', '-q', '-m', message]); return git(dev, ['rev-parse', 'HEAD']); };
  const seed = commit('README.md', 'seed\n', 'chore: seed');
  const remote = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', dev, remote]);
  git(dev, ['remote', 'add', 'origin', remote]);
  git(dev, ['checkout', '-q', '--detach', seed]);
  const sha = commit('item-1.txt', 'item 1\n', 'feat(core): item 1 [P7]');
  git(dev, ['push', '-q', 'origin', `${sha}:refs/heads/item/1`]);
  const pidFile = join(root, 'check.pid');
  const payload = { remote, trunk: 'refs/heads/main', expect: seed, items: [{ id: 1, commit: sha, ref: 'refs/heads/item/1' }],
    check: ['sh', '-c', `sleep 300 & echo $! > '${pidFile}'; wait`], proofMinutes: 0.02 };
  const receipt = await runLandingJob(payload, { workdir: join(root, 'runner'), env: { PATH: process.env.PATH } });
  assert.equal(receipt.outcome, 'proof-timeout');
  assert.match(receipt.detail, /^LAND_PROOF_TIMEOUT: /u);
  assert.deepEqual([receipt.landed, receipt.returned], [[], []]);
  assert.equal(git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']), seed, 'trunk is where it was');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await waitForState(() => !alive(pid), 'the check\'s process tree is stopped');
});

test('clause 1: a proof-timeout receipt offers the landing again, then names LAND_PROOF_TIMEOUT to the coordinator [C7,#7820]', t => {
  const { board, id, sha } = accepted(t);
  offerLandingJob(board.db, { items: [{ id, commit: sha }], expect: sha, config: { trunk: { remote: '/nowhere.git' } } });
  const call = body => jobQueueCall(board.db, body, { mode: 'pull' });
  const jobs = [];
  for (let round = 0; round < 3; round++) {
    const { claim: taken } = call({ action: 'claim', runner: 'stub', capabilities: [], kinds: ['land'] });
    const receipt = { kind: 'land', outcome: 'proof-timeout', detail: 'LAND_PROOF_TIMEOUT: the landing proof ran past the landing\'s 20-minute limit', landed: [], already: [], returned: [], attempts: 1, moved: [], phases: [] };
    call({ action: 'receipt', job: taken.job, runner: 'stub', token: taken.token, receipt });
    applyLandingReceipt(board, { job: taken.job, receipt });
    jobs.push(taken.job);
    const open = board.db.prepare("SELECT job_id FROM job WHERE job_kind = 'land' AND job_step <> 'done'").all();
    assert.equal(open.length, round < 2 ? 1 : 0, `round ${round}: ${JSON.stringify(open)}`);
  }
  assert.match(jobs[1], /~r1$/u);
  assert.match(jobs[2], /~r2$/u);
  assert.equal(getItem(board, id).item_status, 'verified', 'the item stays accepted');
  const notes = itemThread(board, id).map(entry => entry.text ?? '').filter(text => /ran past its deadline/u.test(text));
  assert.equal(notes.length, 3, JSON.stringify(notes));
  assert.match(notes[0], /offered land job .*~r1 \(retry 1 of 2\)/u);
  assert.match(notes[2], /LAND_PROOF_TIMEOUT after 3 tries/u);
  const shouts = board.db.prepare("SELECT shout_text FROM shout WHERE shout_to = 'coordinator'").all().map(row => row.shout_text);
  assert.ok(shouts.some(text => text.startsWith('LAND_PROOF_TIMEOUT: ') && text.includes(`#${id}`)), JSON.stringify(shouts));
});

test('clause 1: the offer carries the push shard limit only when the setting is not the default [C7,#7820]', t => {
  const { board, id, sha } = accepted(t);
  const payload = config => JSON.parse(board.db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(offerLandingJob(board.db, { items: [{ id, commit: sha }], expect: sha, config: { trunk: { remote: '/nowhere.git' }, ...config } }).id).job_step_payload).payload;
  assert.equal(payload({ pushGate: { shardMinutes: 20 } }).proofMinutes, undefined);
  board.db.prepare("DELETE FROM job").run();
  assert.equal(payload({ pushGate: { shardMinutes: 45 } }).proofMinutes, 45);
});
