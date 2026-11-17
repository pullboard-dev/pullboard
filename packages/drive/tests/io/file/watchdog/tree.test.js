/** Gates send a candidate's tree id; a runner's store takes only the objects it lacks [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { driveOnce } from '../../../../index.js';
import { createJob } from '../../../../../jobs/index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../gate/tests/fixtures/child.js';
import { listTreeObjects } from '../../../../../pin/index.js';
import { packObjects } from '../../../../../pin/index.js';
import { treeOf } from '../../../../../pin/index.js';
import { createTransport } from '../../../../../transport/index.js';
import { ensureSource } from '../../../../../transport/index.js';
import { shellWord } from '../../../../../transport/index.js';

const scratch = privateFixtureFiles('pullboard-tree-source-');
after(() => rmSync(scratch.root, { recursive: true, force: true }));

/** Build a throwaway repository with two commits that change one file, and return the repo, both commits and both tree ids. */
function repoWithTwoBases() {
  const files = privateFixtureFiles('pullboard-tree-repo-');
  const repo = files.root;
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'tree@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Tree Test']);
  files.write('keep/one.txt', 'one\n');
  files.write('keep/two.txt', 'two\n');
  files.write('src/a.txt', 'a1\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'first']);
  const firstCommit = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  files.write('src/a.txt', 'a2\n');
  runFixtureGit(['-C', repo, 'commit', '-q', '-am', 'second']);
  const secondCommit = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  return { repo, firstCommit, secondCommit, first: treeOf(repo, firstCommit), second: treeOf(repo, secondCommit) };
}

/** The sender side of a source, as the driver builds it: the tree id with the repository's lister and packer. */
function sourceOf(repo, tree) {
  return { tree, objects: () => listTreeObjects(repo, tree), pack: ids => packObjects(repo, ids) };
}

/** A transport whose runner is a local `sh` rooted in a private folder, so the runner's store and folders are real files. */
function localRunner(name) {
  const root = join(scratch.root, name);
  scratch.write(`${name}/.keep`, '');
  const transport = createTransport({ open: () => spawn('sh', { stdio: ['pipe', 'pipe', 'pipe'] }) });
  return { transport, runner: { host: name, root } };
}

test('clause 1: a gate sends the candidate tree id and the runner materialises only the objects it lacks, a second gate on the same base sending only the changed objects [C7]', async () => {
  const { repo, first, second } = repoWithTwoBases();
  const { transport, runner } = localRunner('runner-a');
  try {
    const channel = transport.connect(runner);
    const log = [];
    const one = await ensureSource(channel, sourceOf(repo, first), line => log.push(line));
    assert.equal(one.held, false);
    assert.equal(one.reused, 0, 'an empty store holds none of the first tree');
    assert.equal(one.sent, one.total);
    assert.equal(readFileSync(join(one.path, 'src/a.txt'), 'utf8'), 'a1\n');
    assert.equal(one.path, join(runner.root, 'source', first));

    const again = await ensureSource(channel, sourceOf(repo, first), line => log.push(line));
    assert.equal(again.held, true, 'the same tree again finds its folder');
    assert.equal(again.sent, 0);
    assert.equal(again.bytesSent, 0);

    const two = await ensureSource(channel, sourceOf(repo, second), line => log.push(line));
    assert.equal(two.sent, 3, 'only the changed blob, the src tree and the root tree move');
    assert.equal(two.reused, two.total - 3);
    assert.ok(two.bytesSent < one.bytesSent, 'the second gate sends fewer bytes than the first');
    assert.equal(readFileSync(join(two.path, 'src/a.txt'), 'utf8'), 'a2\n');
    assert.equal(readFileSync(join(two.path, 'keep/one.txt'), 'utf8'), 'one\n');
    assert.equal(existsSync(join(two.path, '.git')), false, 'the source folder carries no repository');
    assert.deepEqual(log.map(line => line.replace(/\d+ of \d+ objects, source bytes sent: \d+/u, 'N')), [
      `source tree ${first} sent to runner-a: N`,
      `source tree ${first} held on runner-a: source objects sent: 0`,
      `source tree ${second} sent to runner-a: N`]);
  } finally { transport.close(); }
});

test('clause 1: a bad tree id or a tree the sender does not hold is refused with a code [C7]', async () => {
  const { repo } = repoWithTwoBases();
  const { transport, runner } = localRunner('runner-b');
  try {
    const channel = transport.connect(runner);
    await assert.rejects(ensureSource(channel, sourceOf(repo, '../escape')), { code: 'TREE_SOURCE_INVALID' });
    await assert.rejects(ensureSource(channel, sourceOf(repo, '0'.repeat(40))), { code: 'TREE_SOURCE_UNKNOWN_TREE' });
  } finally { transport.close(); }
});

/** Ask the runner's own shell to wait, bounded, until the shard's result file exists. */
async function resultWritten(transport, runner, job, shard) {
  const file = shellWord(`${runner.root}/transport/jobs/${job}/${shard}/result`);
  const reply = await transport.connect(runner).run(`i=0; while [ ! -f ${file} ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; [ -f ${file} ]`);
  assert.equal(reply.status, 0, `no result file at ${file}`);
}

test('clause 1: the production driver driveOnce runs real gates that send source by tree id, the second gate on the same base sending only the changed objects [C7]', async t => {
  const { repo, firstCommit, secondCommit, first, second } = repoWithTwoBases();
  const { transport, runner } = localRunner('runner-c');
  const board = fixtureBoard(t);
  try {
    let clock = 10_000;
    /** Drive one gate job from queued to its verdict and return its running step. */
    const gate = async (id, candidate) => {
      createJob(board.db, { id, kind: 'gate', candidate, base: candidate, now: 1 });
      const options = { owner: 'driver-c', repo, runner, transport, bundles: join(scratch.root, 'bundles'), now: () => clock,
        plan: captured => [{ shard: 's0', command: `test "$(cat ${captured.sourcePath}/src/a.txt)" = ${captured.tree === first ? 'a1' : 'a2'}` }] };
      let moved;
      for (let step = 0; step < 10 && moved?.phase !== 'verdict'; step++) {
        clock += 1000;
        moved = await driveOnce(board.db, id, options);
        if (moved.transition === 'running') await resultWritten(transport, runner, id, 's0');
      }
      assert.equal(moved.phase, 'verdict');
      assert.equal(moved.job.steps.find(s => s.name === 'verdict').payload.verdict, 'green', 'the shard read the source folder the driver sent');
      return moved.job.steps.find(s => s.name === 'running').payload;
    };
    const one = await gate('g1', firstCommit);
    assert.equal(one.source.tree, first);
    assert.equal(one.source.held, false);
    assert.equal(one.source.sent, one.source.total, 'the first gate on an empty runner sends every object');
    assert.equal(one.source.path, join(runner.root, 'source', first));
    assert.match(one.shards[0].command, new RegExp(`${join(runner.root, 'source', first)}/src/a.txt`, 'u'), 'the shard reads the sent source');

    const two = await gate('g2', secondCommit);
    assert.equal(two.source.tree, second);
    assert.equal(two.source.sent, 3, 'the second gate sends only the changed blob and its two trees');
    assert.equal(two.source.reused, two.source.total - 3);
    assert.ok(two.source.bytesSent < one.source.bytesSent);

    const third = await gate('g3', secondCommit);
    assert.equal(third.source.held, true, 'a gate on a tree the runner holds sends nothing');
    assert.equal(third.source.bytesSent, 0);
  } finally { transport.close(); }
});
