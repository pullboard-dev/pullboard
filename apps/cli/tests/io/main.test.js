/** A requeued, recovered or retried gate runs current main tooling while it proves the source its submit named [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../fixtures/child.js';
import { runFixtureGit } from '../fixtures/child.js';
import { prepareDeadHandoffRetry } from '../../../../packages/items/index.js';
import { currentHandoffTools } from '../../src/io/submit/handoff.js';
import { toolsSnapshot } from '../../src/io/submit/handoff.js';
import { withFixtureBoard } from '../fixtures/testkit.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { driveOnce } from '../../../../packages/drive/index.js';

/** A tool root (a Pullboard checkout stand-in), a project repo and one stopped job's captured request at tooling A. */
function stoppedGate(t) {
  const tool = privateFixtureFiles('pullboard-retry-tool-root-');
  for (const args of [['init', '-q'], ['config', 'user.email', 'retry@example.test'], ['config', 'user.name', 'Retry Test']]) runFixtureGit(['-C', tool.root, ...args]);
  tool.write('package.json', '{"name":"tool"}\n');
  tool.write('packages/gate/src/io/shards/proof.js', `export const MARK = 'A ${tool.root}';\n`);
  runFixtureGit(['-C', tool.root, 'add', '-A']);
  runFixtureGit(['-C', tool.root, 'commit', '-q', '-m', 'tooling A']);
  const project = privateFixtureFiles('pullboard-retry-project-');
  for (const args of [['init', '-q'], ['config', 'user.email', 'retry@example.test'], ['config', 'user.name', 'Retry Test']]) runFixtureGit(['-C', project.root, ...args]);
  project.write('a.txt', 'submitted\n');
  runFixtureGit(['-C', project.root, 'add', '-A']);
  runFixtureGit(['-C', project.root, 'commit', '-q', '-m', 'submitted source']);
  const commit = runFixtureGit(['-C', project.root, 'rev-parse', 'HEAD']);
  const tree = runFixtureGit(['-C', project.root, 'rev-parse', 'HEAD^{tree}']);
  const commonDir = join(project.root, '.git');
  const job = { id: '3c1d0000-0000-4000-8000-000000000001', commit, tree, executionCommit: commit, executionTree: tree };
  const captured = toolsSnapshot(tool.root, job.id, commonDir);
  const directory = join(commonDir, 'pullboard', 'submit-handoffs', job.id);
  mkdirSync(directory, { recursive: true });
  const request = { item: 7, job: job.id, commonDir, origin: project.root, commit, tools: captured, toolRoot: tool.root, toolsCommit: runFixtureGit(['-C', tool.root, 'rev-parse', 'HEAD']) };
  writeFileSync(join(directory, 'request.json'), JSON.stringify(request) + '\n');
  const made = [captured];
  t.after(() => { for (const folder of made) rmSync(folder, { recursive: true, force: true }); });
  /** Land tooling B on the tool root, as main moves after the submit. */
  const landB = () => {
    tool.write('packages/gate/src/io/shards/proof.js', `export const MARK = 'B ${tool.root}';\n`);
    runFixtureGit(['-C', tool.root, 'commit', '-q', '-am', 'tooling B']);
    return runFixtureGit(['-C', tool.root, 'rev-parse', 'HEAD']);
  };
  return { tool, commonDir, job, directory, request, captured, made, landB };
}

test('clause 1: a gate retried after main moved runs drive, proof-shards, resources and runners code from its tool root HEAD, not the submit-time tools copy [C7]', t => {
  const gate = stoppedGate(t);
  const b = gate.landB();
  const retry = prepareDeadHandoffRetry(gate.commonDir, 7, gate.job, gate.directory, { refresh: (id, request) => currentHandoffTools(request, id, gate.commonDir) });
  gate.made.push(retry.tools);
  assert.notEqual(retry.tools, gate.captured, 'the retry names a different tools folder');
  assert.match(readFileSync(join(retry.tools, 'packages/gate/src/io/shards/proof.js'), 'utf8'), /'B /u, 'the retry runs tooling B');
  assert.match(readFileSync(join(gate.captured, 'packages/gate/src/io/shards/proof.js'), 'utf8'), /'A /u, 'the captured tools still hold tooling A');
  const written = JSON.parse(readFileSync(join(retry.directory, 'request.json'), 'utf8'));
  assert.equal(written.tools, retry.tools);
  assert.equal(written.toolsCommit, b, 'the retry records the tooling commit it runs');
});

test('clause 2: a gate infrastructure fix landed on main reaches the queued gate at its next attempt, which still proves the submitted commit [C7]', t => {
  const gate = stoppedGate(t);
  gate.landB();
  const retry = prepareDeadHandoffRetry(gate.commonDir, 7, gate.job, gate.directory, { refresh: (id, request) => currentHandoffTools(request, id, gate.commonDir) });
  gate.made.push(retry.tools);
  const written = JSON.parse(readFileSync(join(retry.directory, 'request.json'), 'utf8'));
  for (const key of ['item', 'commonDir', 'origin', 'commit', 'toolRoot']) assert.deepEqual(written[key], gate.request[key], `${key} is the submit's`);
  assert.equal(written.job, retry.id, 'only the job id, tools and tooling commit change');
  // A refresh that cannot build current tooling keeps the captured tools, so the retry still runs.
  const kept = prepareDeadHandoffRetry(gate.commonDir, 7, gate.job, gate.directory, { refresh: () => { throw new Error('tool root gone'); } });
  assert.equal(kept.tools, gate.captured, 'a failed refresh keeps the captured tools');
  assert.ok(existsSync(join(kept.directory, 'request.json')));
});

test('clause 3: the gate\'s captured step records the tooling commit it ran and the source commit it proved [C7]', async t => {
  const gate = stoppedGate(t);
  const b = gate.landB();
  const retry = prepareDeadHandoffRetry(gate.commonDir, 7, gate.job, gate.directory, { refresh: (id, request) => currentHandoffTools(request, id, gate.commonDir) });
  gate.made.push(retry.tools);
  const request = JSON.parse(readFileSync(join(retry.directory, 'request.json'), 'utf8'));
  const board = privateFixtureFiles('pullboard-requeue-board-');
  await withFixtureBoard(join(board.root, 'board.sqlite'), async ({ db }) => {
    createJob(db, { id: `gate-drive:${retry.id}`, kind: 'gate-drive', item: 7, candidate: request.commit, base: request.commit });
    await driveOnce(db, `gate-drive:${retry.id}`, { owner: 'driver-requeue', repo: request.origin, ran: { toolsCommit: request.toolsCommit } });
    const captured = jobView(db, `gate-drive:${retry.id}`).steps.find(step => step.name === 'captured').payload;
    assert.equal(captured.toolsCommit, b, 'the tooling commit the retry ran: main after the fix');
    assert.equal(captured.source, gate.request.commit, 'the source commit it proved: the submitted one');
  });
});
