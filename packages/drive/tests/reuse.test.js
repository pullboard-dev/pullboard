/** A runner that holds the tooling pin starts a gate without copying tooling, and the gate log shows zero bytes sent [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { driveOnce } from '../index.js';
import { createJob } from '../../jobs/index.js';
import { fixtureBoard } from '../../board/tests/fixtures/board.js';
import { privateFixtureFiles } from '../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../apps/cli/tests/fixtures/child.js';
import { bundleFor } from '../../pin/index.js';
import { toolingFor } from '../../pin/index.js';
import { writeToolingPin } from '../../pin/index.js';
import { createTransport } from '../../transport/index.js';
import { ensureTooling } from '../../transport/index.js';
import { dispatchGate } from '../../transport/index.js';
import { toolingFolder } from '../../transport/index.js';

const files = privateFixtureFiles('pullboard-tooling-reuse-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** A repo whose one commit is also the landed tooling, so the pin names its tree. */
function pinnedRepo(name = 'repo') {
  const repo = join(files.root, name);
  files.write(`${name}/tool.txt`, 'tooling\n');
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'pin@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Pin Test']);
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'tooling']);
  writeToolingPin(repo, 'HEAD');
  const pin = toolingFor(repo, 'HEAD');
  return { repo, tooling: pin.tooling, bundle: bundleFor(repo, pin.tooling, join(files.root, 'bundles')).path };
}

/** A transport whose runner is a local `sh` rooted in a private folder, so the runner's copy is real files. */
function localRunner(name) {
  const root = join(files.root, name);
  files.write(`${name}/.keep`, '');
  const transport = createTransport({ open: () => spawn('sh', { stdio: ['pipe', 'pipe', 'pipe'] }) });
  return { transport, runner: { host: name, root } };
}

test('clause 1: a gate on a runner that holds the tooling pin sends zero tooling bytes and reads the pinned copy [C7]', async () => {
  const { tooling, bundle } = pinnedRepo();
  const { transport, runner } = localRunner('runner-a');
  const log = [];
  const first = await ensureTooling(transport.connect(runner), { tree: tooling, bundle }, line => log.push(line));
  assert.equal(first.held, false);
  assert.ok(first.bytesSent > 0, 'a runner without the pin is sent the bundle once');
  assert.equal(existsSync(join(runner.root, 'tooling', tooling, 'tool.txt')), true);

  const gateLog = [];
  const results = await dispatchGate({
    runner, job: 'job-1', transport, intervalMs: 10, tooling: { tree: tooling, bundle }, log: line => gateLog.push(line),
    shards: [{ shard: 's1', command: `cat ${join(runner.root, 'tooling', tooling, 'tool.txt')}` }],
  });
  assert.equal(results[0].status, 0);
  assert.equal(results[0].output.toString('utf8'), 'tooling\n', 'the shard read the pinned copy');
  assert.deepEqual(gateLog, [`tooling pin ${tooling} held on runner-a: tooling bytes sent: 0`]);
  transport.close();
});

test('clause 1: the tooling folder is named by tree id and refuses an id that is not a full tree id [C7]', () => {
  assert.throws(() => toolingFolder('/r', '../x'), { code: 'TRANSPORT_TOOLING_TREE' });
  assert.equal(toolingFolder('/r', 'a'.repeat(40)), `'/r'/tooling/${'a'.repeat(40)}`);
});

test('clause 1: the production driver driveOnce sends a runner that holds the tooling pin zero tooling bytes and plans the shard on the pinned copy [C7]', async t => {
  const { repo, tooling, bundle } = pinnedRepo('repo-b');
  const { transport, runner } = localRunner('runner-b');
  await ensureTooling(transport.connect(runner), { tree: tooling, bundle });
  const board = fixtureBoard(t);
  try {
    const head = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
    createJob(board.db, { id: 'g1', kind: 'gate', candidate: head, base: head, now: 1 });
    const options = { owner: 'driver-a', repo, runner, transport, bundles: join(files.root, 'bundles'), now: () => 10_000,
      plan: captured => [{ shard: 's1', command: `cat ${captured.toolingPath}/tool.txt` }] };
    await driveOnce(board.db, 'g1', options);
    const sent = await driveOnce(board.db, 'g1', options);
    const running = sent.job.steps.find(step => step.name === 'running').payload;
    assert.equal(running.tooling.held, true, 'the runner already held the pin, so the driver copied nothing');
    assert.equal(running.tooling.bytesSent, 0);
    assert.equal(running.tooling.tree, tooling);
    assert.equal(running.shards[0].command, `cat ${join(runner.root, 'tooling', tooling)}/tool.txt`, 'the shard reads the pinned copy');
  } finally {
    transport.close();
  }
});
