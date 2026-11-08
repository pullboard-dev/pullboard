import { submitHandoffEventContract } from './generated-doc-handoff-fixture.js';
/** Real queued submissions retain immutable source and native gate authority [V4,H16,E18]. */
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runFixtureChild } from './fixture-child.js';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { openBoard } from '../apps/lib/index.js';
import { getItem } from '../packages/store/index.js';
import { submitHandoff } from '../src/submit-handoff-read.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { writeBoardCommand } from '../src/board-command-write.js';
import { shout } from '../packages/store/index.js';
import { completeSubmitHandoff, startSubmitHandoff } from '../src/submit-handoff-state.js';
import { fixtureAdd } from './testkit-fixture.js';
import { fixtureJoin } from './testkit-fixture.js';
import { document, fixture, removeSandboxes, state, waitJob, word, workerDiagnostic, workerGone, helpersCommit } from './submit-handoff-fixture.js';

test('queue preparation retries a real peer commit and still bounds continuous changes [B2,V4,H16,E18]', t => {
  const box = fixture(t);
  // @pullboard-board-file locking: a second native connection commits while source sealing is outside BEGIN.
  const board = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  const peer = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  try {
    const item = getItem(board, box.id);
    const seal = board.enginePorts.sealSubmitHandoffQueue;
    let calls = 0;
    let continuous = true;
    board.enginePorts = { ...board.enginePorts,
      /** Preserve the real source seal and introduce only an actual concurrent native message. */
      sealSubmitHandoffQueue(b, id, options) {
        const result = seal(b, id, options);
        calls++;
        if (continuous || calls === 1) shout(peer, { from: item.item_owner, to: 'all', text: `Peer commit during queue preparation ${calls}` });
        return result;
      },
    };
    const options = { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
      commit: box.commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), executionCommit: box.commit,
      executionTree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), digest: item.item_frozen_digest,
      companionDigest: null, leaseMs: 7_200_000 };
    assert.throws(() => writeBoardCommand(board, 'queueSubmitHandoff', [box.id, options], item.item_owner), { code: 'BOARD_BUSY' });
    assert.equal(calls, 4, 'continuous commits exhaust the existing four attempts without widening its budget');
    assert.equal(submitHandoff(board, box.id), null, 'no stale queue record is partially published');
    continuous = false;
    calls = 0;
    const result = writeBoardCommand(board, 'queueSubmitHandoff', [box.id, options], item.item_owner);
    assert.equal(calls, 2, 'one real peer commit causes exactly one fresh preparation');
    assert.equal(result.created, true);
    assert.equal(result.job.commit, box.commit);
    assert.equal(result.job.agentId, item.item_owner);
    completeSubmitHandoff(board, box.id, { agentId: item.item_owner, job: result.job.id,
      result: { code: 1, error: { code: 'FIXTURE_FINISHED', message: 'The private native queue observation finished.', next: 'No worker was launched.' } } });
  } finally { peer.db.close(); board.db.close(); }
});

/** The board a queued-hand-off test drives directly, opened once here so the raw-board count does not grow. */
const queueBoard = box => openBoard(box.boardFile, undefined, { gitRoot: box.web });

test('clause 1: a queued red returned to its builder writes submitOutcome with the refusal code and its pipelineCause on the same renew event [C7,V4]', t => {
  const box = fixture(t);
  const board = queueBoard(box);
  try {
    const item = getItem(board, box.id);
    const options = { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
      commit: box.commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), executionCommit: box.commit,
      executionTree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), digest: item.item_frozen_digest,
      companionDigest: null, leaseMs: 7_200_000 };
    const queued = writeBoardCommand(board, 'queueSubmitHandoff', [box.id, options], item.item_owner);
    const done = completeSubmitHandoff(board, box.id, { agentId: item.item_owner, job: queued.job.id,
      result: { code: 1, error: { code: 'TEST_FAILURE', message: 'one test file failed in the queued gate', next: 'fix it' } } });
    assert.equal(done.state, 'red');
    const renew = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='renew' ORDER BY event_id DESC LIMIT 1").get(box.id);
    const detail = JSON.parse(renew.event_detail);
    assert.equal(detail.queuedRedReturn, true);
    assert.equal(detail.submitOutcome.code, 'TEST_FAILURE');
    assert.equal(detail.submitOutcome.digest, item.item_frozen_digest);
    assert.equal(detail.submitOutcome.pipelineCause.type, 'test-failure');
  } finally { board.db.close(); }
});

test('a queued gate stopped by an infrastructure Git read stays claimed and is never returned to the builder as red [C7,V4]', t => {
  const box = fixture(t);
  const board = queueBoard(box);
  try {
    const item = getItem(board, box.id);
    const options = { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
      commit: box.commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), executionCommit: box.commit,
      executionTree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), digest: item.item_frozen_digest,
      companionDigest: null, leaseMs: 7_200_000 };
    const queued = writeBoardCommand(board, 'queueSubmitHandoff', [box.id, options], item.item_owner);
    const done = completeSubmitHandoff(board, box.id, { agentId: item.item_owner, job: queued.job.id,
      result: { code: 1, error: { code: 'GIT_READ_INFRASTRUCTURE', message: 'the accepted cells-plan presence could not be read from Git', next: 'retry' } } });
    assert.equal(done.state, 'infrastructure');
    assert.equal(getItem(board, box.id).item_status, 'claimed');
    assert.equal(getItem(board, box.id).item_owner, item.item_owner, 'the builder keeps its claim');
    const texts = board.db.prepare('SELECT shout_to AS to_, shout_text AS text FROM shout').all();
    assert.equal(texts.some(row => row.to_ === item.item_owner && /Fix it, commit and submit again/u.test(row.text)), false);
  } finally { board.db.close(); }
});

/**
 * Queue a fresh gate for the fixture's claimed item and complete it with one refusal, as the worker records it.
 *
 * @returns {{ done: object, item: object, owner: string, shouts: Array<{ to_: string, text: string }> }}
 */
function completeQueued(box, board, error) {
  const item = getItem(board, box.id);
  const queued = writeBoardCommand(board, 'queueSubmitHandoff', [box.id, { agentId: item.item_owner, job: randomUUID(),
    main: box.git(box.web, 'rev-parse', 'main'), commit: box.commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'),
    executionCommit: box.commit, executionTree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), digest: item.item_frozen_digest,
    companionDigest: null, leaseMs: 7_200_000 }], item.item_owner);
  const done = completeSubmitHandoff(board, box.id, { agentId: item.item_owner, job: queued.job.id, result: { code: 1, error } });
  return { done, item: getItem(board, box.id), owner: item.item_owner,
    shouts: board.db.prepare('SELECT shout_to AS to_, shout_text AS text FROM shout').all() };
}

/** Assert a machine stop: state infrastructure, the builder keeps its claim and gets no red, and the coordinator hears of it. */
function assertMachineStop(box, board, error) {
  const before = board.db.prepare('SELECT COUNT(*) AS n FROM shout').get().n;
  const { done, item, owner, shouts } = completeQueued(box, board, error);
  assert.equal(done.state, 'infrastructure', `${error.code} ends in state infrastructure`);
  assert.equal(item.item_status, 'claimed', `${error.code} leaves the item claimed`);
  assert.equal(item.item_owner, owner, `${error.code} leaves the claim with its builder`);
  const added = shouts.slice(before);
  assert.equal(added.some(row => row.to_ === owner), false, `${error.code} sends the builder no red`);
  assert.ok(added.some(row => row.to_ === 'coordinator' && row.text.includes(error.code)), `${error.code} shouts the coordinator: ${JSON.stringify(added)}`);
}

test('machine refusals RUNNER_RESULT_INVALID, RESOURCE_LEASE_LOST, GIT_SYNC_LOCK_BUSY and GIT_SYNC_REMOTE end infrastructure, stay claimed and shout the coordinator, clause 1 of #3111 [C7]', t => {
  const box = fixture(t);
  const board = queueBoard(box);
  try {
    for (const code of ['RUNNER_RESULT_INVALID', 'RESOURCE_LEASE_LOST', 'GIT_SYNC_LOCK_BUSY', 'GIT_SYNC_REMOTE']) {
      assertMachineStop(box, board, { code, message: `the machine refused with ${code}`, next: 'retry once the machine recovers' });
    }
  } finally { board.db.close(); }
});

test('a worker that exits on a signal without a terminal result ends the same way, clause 2 of #3111 [C7]', t => {
  const box = fixture(t);
  const board = queueBoard(box);
  try {
    assertMachineStop(box, board, { code: 'SUBMIT_HANDOFF_EXIT', message: 'the queued gate worker exited on SIGTERM before it recorded a result', next: 'retry' });
  } finally { board.db.close(); }
});

test('GATE_RED and MERGE_CONFLICT still return a red to the builder, clause 3 of #3111 [C7]', t => {
  for (const code of ['GATE_RED', 'MERGE_CONFLICT']) {
    const box = fixture(t);
    const board = queueBoard(box);
    try {
      const { done } = completeQueued(box, board, { code, message: `the source is red: ${code}`, next: 'fix it and submit again' });
      assert.equal(done.state, 'red', `${code} is a red`);
    } finally { board.db.close(); }
  }
});

test('two item folders stamp and queue their own claims while the first gate runs [B5,V4]', async t => {
  const box = fixture(t, { firstFolder: true });
  assert.match(box.git(box.source, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${box.id}\\b`));
  assert.equal(box.helpers.commitFile(box, box.secondFolder, 'web/second.txt', 'second\n', 'feat(web): second folder [G1]').status, 0);
  assert.match(box.git(box.secondFolder, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${box.second}\\b`));
  assert.doesNotMatch(box.git(box.secondFolder, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${box.id}\\b`));
  const marker = box.git(box.source, 'rev-parse', '--git-path', 'pullboard-item.json');
  rmSync(marker);
  document(box.run(box.source, 'status', '--json'));
  const restored = `${JSON.stringify({ version: 1, seat: state(box, box.id).item.item_owner, item: box.id })}\n`;
  const blob = createHash('sha1').update(`blob ${Buffer.byteLength(restored)}\0${restored}`).digest('hex');
  assert.equal(box.git(box.source, 'hash-object', marker), blob, 'pre-marker folder restores its own private identity');
  writeFileSync(marker, '{broken');
  assert.equal(box.run(box.source, 'status', '--json').code, 1, 'a damaged marker is never silently replaced');
  rmSync(marker);
  for (const command of [['status'], ['inbox'], ['show', String(box.id)]]) document(box.run(box.source, ...command, '--json'));
  const renewed = document(box.run(box.source, 'claim', String(box.id), '--json'));
  assert.equal(renewed.itemFolder, box.source, 'renewing inside the folder reopens the same folder beside the seat');
  const first = document(box.run(box.source, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(first.commit, box.commit);
  await box.helpers.waitFor(() => existsSync(box.started), 'first folder gate started', 120000); // budget: observed worker progress ceiling, not a timing assertion.
  const queued = document(box.run(box.secondFolder, 'submit', String(box.second), '--no-next', '--json'));
  assert.equal(queued.queued, true);
  assert.equal(state(box, box.second).job.commit, box.git(box.secondFolder, 'rev-parse', 'HEAD'), 'the queued seal captures the second folder, not the seat checkout');
  assert.equal(existsSync(box.release), false);
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'green');
  await box.helpers.waitFor(() => { // budget: worker cleanup hang ceiling, not a timing assertion.
    const job = state(box, box.second).job;
    return job && job.state === 'green' && !existsSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'source'));
  }, 'second folder worker cleanup', 120000);
  assert.equal(state(box, box.id).item.item_status, 'submitted');
  assert.equal(state(box, box.second).item.item_status, 'submitted');
});

test('foreground submit from each of two item folders submits that folder\'s item [B5,V4]', t => {
  const box = fixture(t, { enabled: false, firstFolder: true });
  writeFileSync(box.release, 'release\n');
  assert.equal(box.helpers.commitFile(box, box.secondFolder, 'web/second.txt', 'second\n', 'feat(web): second folder [G1]').status, 0);
  const secondHead = box.git(box.secondFolder, 'rev-parse', 'HEAD');
  const wrong = box.run(box.secondFolder, 'submit', String(box.id), '--no-next', '--json');
  assert.equal(JSON.parse(wrong.out).error.code, 'NOT_YOURS', 'a folder submits only its own item');
  document(box.run(box.secondFolder, 'submit', String(box.second), '--no-next', '--json'));
  document(box.run(box.source, 'submit', String(box.id), '--no-next', '--json'));
  assert.deepEqual([state(box, box.id).item.item_status, state(box, box.id).item.item_commit], ['submitted', box.commit]);
  assert.deepEqual([state(box, box.second).item.item_status, state(box, box.second).item.item_commit], ['submitted', secondHead]);
});

test('queued submit returns before its gate and remains bound when the builder commits and claims again [B5,V4,H16,E18]', async t => {
  const box = fixture(t, { companion: true });
  const author = join(box.dir, 'companion-author');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', author, box.commit);
  const authorId = document(fixtureJoin(box.run, author, 'api', '--json')).agent;
  mkdirSync(join(author, 'api'), { recursive: true });
  writeFileSync(join(author, 'api', 'companion.txt'), 'required\n');
  box.git(author, 'add', 'api/companion.txt');
  const patch = join(box.dir, 'companion.diff');
  writeFileSync(patch, box.git(author, 'diff', '--cached', '--binary') + '\n');
  document(box.run(box.repo, 'patch', 'attach', String(box.id), patch, '--key', 'required-companion', '--author', authorId, '--source', box.commit, '--json'));
  const queued = document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(queued.queued, true);
  assert.equal(queued.commit, box.commit);
  assert.match(queued.companionDigest, /^[a-f0-9]{64}$/u);
  assert.equal(document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json')).commit, queued.commit);
  assert.equal(existsSync(box.release), false, 'submit acknowledged while the gate was still blocked');
  await box.helpers.waitFor(() => existsSync(box.started), 'actual captured gate execution', 120000); // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  assert.equal(state(box, box.id).item.item_status, 'claimed', 'unproved work is never reviewable');
  box.git(box.web, 'checkout', '-q', '--detach', 'main');
  assert.equal(helpersCommit(box, 'web/later.txt', 'later\n').status, 0);
  assert.equal(existsSync(join(box.web, 'web/snapshot.txt')), false, 'the next build no longer contains the queued candidate');
  document(box.run(box.web, 'claim', String(box.second), '--json'));
  assert.equal(helpersCommit(box, 'web/second.txt', 'second\n').status, 0, 'real commit hooks select only the ordinary second claim');
  const secondQueued = document(box.run(box.web, 'submit', String(box.second), '--no-next', '--json'));
  assert.equal(secondQueued.queued, true, 'the second committed item also submits while the first gate is blocked');
  document(box.run(box.web, 'claim', String(box.third), '--json'));
  const fourth = document(fixtureAdd(box.run, box.repo, 'web', 'Fourth ordinary build', '--specs', 'G1', '--criterion', 'One ordinary build at a time.', '--check', 'true', '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(fourth), '--json'));
  assert.equal(state(box, fourth).item.item_owner, state(box, box.third).item.item_owner, 'B5 permits several live claims in their own folders');
  const duplicate = state(box, box.id).job;
  assert.equal(duplicate.commit, box.commit);
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'green');
  await box.helpers.waitFor(() => state(box, box.second).job?.state === 'green', 'second native submit completes independently', 120000); // budget: owned-worker cleanup ceiling, not a performance assertion.
  const completed = state(box, box.id);
  assert.equal(completed.item.item_status, 'submitted');
  assert.equal(completed.item.item_commit, box.commit);
  assert.equal(state(box, box.second).item.item_built_by, completed.job.agentId);
  assert.deepEqual(readFileSync(box.started, 'utf8').trim().split('\n').map(JSON.parse), [{ value: 'green', head: completed.job.executionCommit }]);
  assert.notEqual(completed.job.executionCommit, box.commit, 'the native companion composition was actually executed');
  assert.deepEqual(readFileSync(box.finished, 'utf8').trim().split('\n').map(JSON.parse), [{ value: 'green', head: completed.job.executionCommit }], 'the gate still read the captured source after the builder moved');
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  // The captured item is filed on the strong route, so its reviewer joins on that route (a mid seat is refused ROUTE).
  document(fixtureJoin(box.run, reviewer, 'api', '--route', 'strong', '--json'));
  assert.equal(document(box.run(reviewer, 'next', '--verify', String(box.id), '--json')).item.item_id, box.id);
});

test('queued gate retains the tool build when the builder changes it [V4,H16,E18]', async t => {
  const box = fixture(t);
  const source = resolve(import.meta.dirname, '..');
  const tools = join(box.dir, 'builder-tools');
  cpSync(source, tools, { recursive: true, filter: path => !path.startsWith(join(source, '.git')) });
  const actualTemp = join(box.dir, 'actual-temp');
  const aliasedTemp = join(box.dir, 'aliased-temp');
  mkdirSync(actualTemp);
  symlinkSync(actualTemp, aliasedTemp, 'dir');
  box.env.TMPDIR = aliasedTemp;
  const result = execFileSync(process.execPath, [join(tools, 'bin/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(JSON.parse(result).queued, true);
  const job = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id);
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  assert.notEqual(request.tools, tools, 'the real worker owns a separate tool snapshot');
  assert.notEqual(request.tools, realpathSync(request.tools), 'the real worker is launched through a symlinked snapshot path');
  assert.equal(existsSync(join(request.tools, '.git')), false, 'tooling never borrows project Git metadata');
  const workerPath = join(request.tools, 'bin/gate-drive-worker.js');
  const originalWorker = readFileSync(workerPath, 'utf8');
  await box.helpers.waitFor(() => existsSync(box.started), 'captured gate begins', 120000); // budget: existing owned-child hang ceiling, not a performance assertion.
  writeFileSync(join(tools, 'bin/gate-drive-worker.js'), "throw new Error('changed builder tooling');\n");
  assert.equal(readFileSync(workerPath, 'utf8'), originalWorker, 'builder mutations cannot change the queued tools');
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'green');
  assert.equal(state(box, box.id).item.item_commit, box.commit);
  await box.helpers.waitFor(() => !existsSync(request.tools), 'owned tool snapshot cleanup', 120000); // budget: existing owned-child cleanup ceiling, not a performance assertion.
  assert.equal(existsSync(join(tools, 'bin/pullboard.js')), true, 'cleanup preserves the builder tool installation');
  writeFileSync(join(tools, 'bin/gate-drive-worker.js'), originalWorker);
  const malformed = join(box.dir, 'malformed-worker-request.json');
  writeFileSync(malformed, JSON.stringify({ tools, job: 'not-native-job', commonDir: join(box.repo, '.git') }));
  const refused = runFixtureChild(process.execPath, [join(tools, 'bin/gate-drive-worker.js'), malformed, 'test-driver'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0, 'an unbound request is refused before any board move');
  assert.equal(existsSync(join(tools, 'bin/pullboard.js')), true, 'a request field cannot authorize deletion of the running installation');
});

test('a queued red retains the exact canonical refusal and the builder claim while another claim stays owned [B5,V4,H16]', async t => {
  const box = fixture(t, { result: 'red' });
  document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  await box.helpers.waitFor(() => existsSync(box.started), 'actual red candidate execution', 120000); // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  document(box.run(box.web, 'claim', String(box.second), '--json'));
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'red');
  const completed = state(box, box.id);
  assert.equal(completed.item.item_status, 'claimed');
  assert.equal(completed.job.error.code, 'GATE_RED');
  const retained = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', completed.job.id, 'refusal.json'), 'utf8'));
  assert.deepEqual(completed.job.error, retained.error);
  assert.equal(state(box, box.second).item.item_owner, completed.job.agentId);
  const shown = document(box.run(box.web, 'show', String(box.id), '--json'));
  assert.deepEqual(shown.queuedSubmit.error, retained.error);
  const interrupt = document(box.run(box.web, 'inbox', '--json')).shouts.find(row => row.shout_text.includes(`Queued submit #${box.id} was refused`));
  assert.ok(interrupt, 'the existing inbox channel carries the red interrupt');
  const other = join(box.dir, 'other-web');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', other, 'main');
  document(fixtureJoin(box.run, other, 'web', '--route', 'strong', '--json'));
  const foreign = box.run(other, 'claim', String(box.id), '--json');
  assert.equal(foreign.code, 1);
  assert.equal(JSON.parse(foreign.out).error.code, 'HELD');
  document(box.run(box.web, 'claim', String(box.id), '--json'));
  assert.equal(state(box, box.id).item.item_owner, state(box, box.second).item.item_owner, 'B5 permits the builder to reclaim alongside another item');
  document(box.run(box.web, 'release', String(box.second), '--reason', 'ROUTED_ELSEWHERE', '--no-next', '--json'));
  document(box.run(box.web, 'claim', String(box.id), '--json'));
  assert.equal(state(box, box.id).item.item_owner, completed.job.agentId, 'the same seat resumes at a natural break');
});


test('setting off retains foreground submit until the real gate finishes [V4]', async t => {
  const box = fixture(t, { enabled: false });
  const child = box.helpers.launch(box, box.web, process.execPath, [box.helpers.BIN, 'submit', String(box.id), '--no-next', '--json']);
  let closed = false;
  child.closed.then(() => { closed = true; });
  await box.helpers.waitFor(() => existsSync(box.started), 'foreground gate execution', 120000); // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  assert.equal(closed, false);
  assert.equal(state(box, box.id).job, null);
  writeFileSync(box.release, 'release\n');
  const exit = await child.closed;
  assert.equal(exit.code, 0, child.stderrText);
  assert.equal(JSON.parse(child.stdoutText).gate.green, true);
});

test('a handoff result cannot invent a green submission or complete another sender job [V4,E18]', async t => {
  const box = fixture(t);
  document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  // @pullboard-board-file journey: observe the separate native worker's actual persisted queue and proof identity.
  const board = openBoard(box.boardFile);
  try {
    const job = submitHandoff(board, box.id);
    assert.throws(() => completeSubmitHandoff(board, box.id, { agentId: 'foreign-seat', job: job.id, result: { code: 0, commit: box.commit } }), { code: 'SUBMIT_HANDOFF_CHANGED' });
    assert.throws(() => completeSubmitHandoff(board, box.id, { agentId: job.agentId, job: job.id, result: { code: 0, commit: box.commit } }), { code: 'SUBMIT_HANDOFF_RESULT' });
    assert.equal(getItem(board, box.id).item_status, 'claimed');
  } finally { board.db.close(); }
});

/** Install a real checkout barrier while preserving and invoking any existing native hook byte-for-byte. */
function checkoutBarrier(box) {
  const ready = join(box.dir, 'private-checkout-ready');
  const release = join(box.dir, 'private-checkout-release');
  box.releases.push(release);
  const script = join(box.dir, 'checkout-barrier.cjs');
  writeFileSync(script, [
    "const fs=require('node:fs'); const cwd=process.cwd();",
    `if(cwd.includes('/submit-handoffs/') && cwd.endsWith('/source') && !fs.existsSync(${JSON.stringify(ready)})) {`,
    ` fs.writeFileSync(${JSON.stringify(ready)},cwd); const deadline=Date.now()+120000;`,
    ` while(!fs.existsSync(${JSON.stringify(release)})) { if(Date.now()>deadline) throw Error('checkout release never arrived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
    '}',
  ].join('\n'));
  const hooks = box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks');
  // Use an absolute spelling of the same active native directory, so linked worktrees share the barrier; all existing guards stay intact.
  box.git(box.repo, 'config', 'core.hooksPath', hooks);
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'post-checkout');
  let original = '';
  if (existsSync(hook)) {
    const copy = join(hooks, 'post-checkout.native');
    writeFileSync(copy, readFileSync(hook));
    chmodSync(copy, 0o755);
    original = `${word(copy)} "$@" || exit "$?"\n`;
  }
  writeFileSync(hook, `#!/bin/sh\n${original}exec ${word(process.execPath)} ${word(script)} "$@"\n`);
  chmodSync(hook, 0o755);
  return { ready, release };
}

test('removing the builder checkout during private source preparation cannot move or strand the queued gate [V4,H16,E18]', async t => {
  const box = fixture(t);
  const barrier = checkoutBarrier(box);
  document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  await box.helpers.waitFor(() => existsSync(barrier.ready), 'actual private checkout hook', 120000); // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  box.git(box.web, 'checkout', '-q', '--detach', 'main');
  assert.equal(helpersCommit(box, 'web/another-build.txt', 'independent\n').status, 0);
  document(box.run(box.web, 'claim', String(box.second), '--json'));
  box.git(box.repo, 'worktree', 'remove', box.web);
  assert.equal(existsSync(box.web), false);
  writeFileSync(barrier.release, 'release\n');
  await box.helpers.waitFor(() => existsSync(box.started), 'captured gate after removal of original checkout', 120000); // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'green');
  const completed = state(box, box.id);
  assert.equal(completed.item.item_status, 'submitted');
  assert.equal(completed.item.item_commit, box.commit);
  assert.equal(state(box, box.second).item.item_owner, completed.job.agentId);
  assert.deepEqual(readFileSync(box.finished, 'utf8').trim().split('\n').map(JSON.parse), [{ value: 'green', head: box.commit }]);
});

/** Build a bounded real test selection, so an unrelated accepted-main move may use the ordinary merge path. */
function mainAdvanceFixture(t) {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const release = join(box.dir, 'advance-release');
  const started = join(box.dir, 'advance-started');
  const armed = join(box.dir, 'advance-armed');
  for (const folder of ['bin', 'test', 'web']) mkdirSync(join(box.repo, folder), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/feature.js'), "export const feature = 'base';\n");
  writeFileSync(join(box.repo, 'web/other.js'), "export const other = 'independent';\n");
  writeFileSync(join(box.repo, 'test/other.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {other} from '../web/other.js';test('independent feature [G1]',()=>assert.equal(other,'independent'));\n");
  writeFileSync(join(box.repo, 'bin/run-tests.js'), [
    "import {spawnSync} from 'node:child_process';",
    "const env={...process.env};delete env.NODE_TEST_CONTEXT;",
    "const run=spawnSync(process.execPath,['--test','--test-reporter=tap',...process.argv.slice(2)],{encoding:'utf8',env});",
    "process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');process.exitCode=run.status??1;",
  ].join('\n'));
  writeFileSync(join(box.repo, 'test/feature.test.js'), [
    "import assert from 'node:assert/strict';import {test} from 'node:test';import fs from 'node:fs';",
    "import {feature} from '../web/feature.js';",
    "test('captured feature [G1]',()=>{assert.equal(feature,'item');",
    `if(fs.existsSync(${JSON.stringify(armed)})){fs.writeFileSync(${JSON.stringify(started)},'started');const deadline=Date.now()+120000;`,
    `while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw Error('release never arrived');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}});`,
  ].join('\n'));
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  // The web lane owns the runner and the test, so claiming the item is not a cross-ownership refusal [C7,#2650].
  const lanes = { ...config.lanes, web: { ...config.lanes.web, owns: [...config.lanes.web.owns, 'bin/', 'test/'] } };
  writeFileSync(configFile, JSON.stringify({ ...config, lanes, gate: 'node bin/run-tests.js test/feature.test.js',
    affectedTests: 'node bin/run-tests.js', submit: { handoff: true } }) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: bounded native moving-main fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Queued proof across accepted main', '--specs', 'G1',
    '--criterion', 'The captured feature is item.', '--check', 'node bin/run-tests.js test/feature.test.js', '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', "export const feature = 'item';\n", 'feat(web): captured implementation [G1]').status, 0);
  document(box.run(box.repo, 'bar', 'ready', 'on', '--json'));
  writeFileSync(armed, 'armed\n');
  t.after(async () => {
    writeFileSync(release, 'release\n');
    await helpers.waitFor(() => {
      const job = state(box, id).job;
      return !job || !existsSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'source'));
    }, `moving-main worker cleanup: ${workerDiagnostic(box, id)}`);
    const job = state(box, id).job;
    if (job) await workerGone(helpers, box, job.id);
    await removeSandboxes(helpers);
  });
  return { ...box, id, helpers, release, started };
}

test('clause 1: queued submit keeps the ordinary hook-checked unrelated-main merge after captured proof [V4,H16,C7]', async t => {
  const box = mainAdvanceFixture(t);
  const queued = document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  try { await box.helpers.waitFor(() => existsSync(box.started), 'real captured feature gate', 120000); } // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  catch (error) { throw new Error(`${error.message}\n${workerDiagnostic(box, box.id)}`, { cause: error }); }
  mkdirSync(join(box.repo, 'docs'), { recursive: true });
  writeFileSync(join(box.repo, 'docs/unrelated.md'), 'accepted unrelated main content\n');
  box.git(box.repo, 'add', 'docs/unrelated.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: unrelated accepted main [G1]');
  const accepted = box.git(box.repo, 'rev-parse', 'HEAD');
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'green');
  const completed = state(box, box.id);
  // 12482431d6 (#2366) defers composing later main to landing, so no merge hook runs and the proof keeps its captured source.
  assert.equal(completed.job.hookProjection, undefined, 'no merge hook ran inside the queued submit');
  assert.equal(completed.item.item_commit, queued.commit, 'the queued proof records its captured source; landing composes later main');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), accepted, 'the unrelated accepted main commit stays on main');
});


test('the handoff documentation receives actual detached-worker event kinds and fields [A5,V4,H16]', async t => {
  const rows = await submitHandoffEventContract(t);
  const queued = rows.filter(row => row.event_kind === 'submit-handoff');
  assert.ok(queued.some(row => row.detail.state === 'queued'));
  assert.ok(queued.some(row => row.detail.state === 'red'));
  // db3dba1506 reopens rejected and returned work to every eligible seat at once, so no first-refusal window is sealed.
  assert.equal(rows.find(row => row.event_kind === 'submit_handoff_returned').detail.reopenFirstRefusal, undefined);
});
