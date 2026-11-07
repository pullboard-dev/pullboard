/** A runner that holds the tooling pin starts a gate without copying tooling, and the gate log shows zero bytes sent [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../test/fixture-child.js';
import { runFixtureGit } from '../../../test/fixture-child.js';
import { bundleFor } from '../../pin/index.js';
import { toolingFor } from '../../pin/index.js';
import { writeToolingPin } from '../../pin/index.js';
import { createTransport } from '../index.js';
import { runGate } from '../index.js';
import { ensureTooling } from '../src/shell/tooling-send.js';
import { toolingFolder } from '../src/shell/tooling-send.js';

const files = privateFixtureFiles('pullboard-tooling-reuse-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** A repo whose one commit is also the landed tooling, so the pin names its tree. */
function pinnedRepo() {
  const repo = join(files.root, 'repo');
  files.write('repo/tool.txt', 'tooling\n');
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
  const results = await runGate({
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
