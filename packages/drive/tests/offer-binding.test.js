/** @pullboard-test-input packages/drive/src/io/once.js */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { driveOnce } from '../index.js';
import { createJob } from '../../jobs/index.js';
import { fixtureBoard } from '../../board/tests/fixtures/board.js';
import { privateFixtureFiles } from '../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../gate/tests/fixtures/child.js';

const files = privateFixtureFiles('pullboard-offer-binding-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** The production driver offers each shard with the gate's tree, base tree and attempt, which a pull runner signs [C7]. */
test('driveOnce offers shards with the gate base, tooling pin and attempt [C7]', async t => {
  const repo = join(files.root, 'repo');
  files.write('repo/a.txt', 'a\n');
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'bind@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Bind Test']);
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'one']);
  const head = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  const tree = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD^{tree}']);
  const offers = [];
  const transport = { connect: () => ({ startShard: async spec => { offers.push(spec); return { state: 'started' }; }, fetchResult: async () => ({ state: 'running' }) }) };
  const board = fixtureBoard(t);
  createJob(board.db, { id: 'g2', kind: 'gate', candidate: head, base: head, now: 1 });
  const options = { owner: 'driver-a', repo, runner: { host: 'pool' }, transport, tooling: false, source: false, now: () => 10_000, plan: () => [{ shard: 's1', command: 'true' }] };
  await driveOnce(board.db, 'g2', options);
  await driveOnce(board.db, 'g2', options);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].tree, tree);
  assert.equal(offers[0].base, tree, 'the base is the base commit\'s tree id');
  assert.equal(typeof offers[0].tooling, 'string');
  assert.equal(offers[0].attempt, '0');
});
