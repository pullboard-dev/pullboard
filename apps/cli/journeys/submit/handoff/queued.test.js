/** A queued submit returns before its gate and keeps the captured source and tool build [B5,V4,H16,E18]. */
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';
import {
  document,
  fixture,
  state,
  waitJob,
  helpersCommit,
} from '../../../tests/fixtures/submit/handoff.js';

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

test('clause 1: a seat holding a claim gets submit --wait back at once with no agent marker, the result through next [P7]', async t => {
  const box = fixture(t);
  for (const name of AGENT_SHELL_MARKERS) delete box.env[name];
  const ran = await box.inProcess(box.web, 'submit', String(box.id), '--wait', '--no-next');
  assert.equal(ran.code, 0, `${ran.out}${ran.err}`);
  assert.match(ran.out, new RegExp(`queued gate for #${box.id}`, 'u'), 'submit queued the gate');
  assert.match(ran.out, /never blocks on its own gate; a red gate comes back through pullboard next/u, 'the reply says the result comes through next');
  assert.match(ran.out, new RegExp(`pullboard show ${box.id}`, 'u'), 'the reply prints the command that reads the result');
  assert.equal(existsSync(box.release), false, 'submit --wait returned while the gate was still held');
  assert.ok(['queued', 'running'].includes(state(box, box.id).job?.state), 'the gate had not finished when submit returned');
});
