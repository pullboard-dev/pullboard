/** Queued submissions from two item folders stay bound to their own claims and sources [B5,V4,H16,E18]. */
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';
import {
  document,
  fixture,
  state,
  waitJob,
  helpersCommit,
} from '../../../tests/fixtures/submit/handoff.js';

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
  const source = resolve(import.meta.dirname, '../../../../..');
  const tools = join(box.dir, 'builder-tools');
  cpSync(source, tools, { recursive: true, filter: path => !path.startsWith(join(source, '.git')) });
  const actualTemp = join(box.dir, 'actual-temp');
  const aliasedTemp = join(box.dir, 'aliased-temp');
  mkdirSync(actualTemp);
  symlinkSync(actualTemp, aliasedTemp, 'dir');
  box.env.TMPDIR = aliasedTemp;
  const result = execFileSync(process.execPath, [join(tools, 'apps/cli/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(JSON.parse(result).queued, true);
  const job = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id);
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  assert.notEqual(request.tools, tools, 'the real worker owns a separate tool snapshot');
  assert.notEqual(request.tools, realpathSync(request.tools), 'the real worker is launched through a symlinked snapshot path');
  assert.equal(existsSync(join(request.tools, '.git')), false, 'tooling never borrows project Git metadata');
  const workerPath = join(request.tools, 'apps/cli/src/io/gate/drive.js');
  const originalWorker = readFileSync(workerPath, 'utf8');
  await box.helpers.waitFor(() => existsSync(box.started), 'captured gate begins', 120000); // budget: existing owned-child hang ceiling, not a performance assertion.
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), "throw new Error('changed builder tooling');\n");
  assert.equal(readFileSync(workerPath, 'utf8'), originalWorker, 'builder mutations cannot change the queued tools');
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'green');
  assert.equal(state(box, box.id).item.item_commit, box.commit);
  await box.helpers.waitFor(() => !existsSync(request.tools), 'owned tool snapshot cleanup', 120000); // budget: existing owned-child cleanup ceiling, not a performance assertion.
  assert.equal(existsSync(join(tools, 'apps/cli/pullboard.js')), true, 'cleanup preserves the builder tool installation');
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), originalWorker);
  const malformed = join(box.dir, 'malformed-worker-request.json');
  writeFileSync(malformed, JSON.stringify({ tools, job: 'not-native-job', commonDir: join(box.repo, '.git') }));
  const refused = runFixtureChild(process.execPath, [join(tools, 'apps/cli/src/io/gate/drive.js'), malformed, 'test-driver'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0, 'an unbound request is refused before any board move');
  assert.equal(existsSync(join(tools, 'apps/cli/pullboard.js')), true, 'a request field cannot authorize deletion of the running installation');
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
