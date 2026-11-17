/** @pullboard-test-input source-cell packages/landing */
/** The landing composition guard reads its module graph from Git objects, cached on disk by tree id [C7,#3359]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellInventory } from '../../codemap/index.js';
import { commonJsIn } from '../../gate/index.js';
import { importsIn } from '../../gate/index.js';
import { keyedResultPath } from '../../pin/index.js';
import { realGitAdapter } from '../../git/index.js';
import { withGitContractAdapter } from '../../git/index.js';
import { fixture } from './fixtures/plan.js';
import { git } from './fixtures/plan.js';

/** The real Git adapter that also records every command's arguments. */
function recording(log) {
  return Object.freeze({
    spawnSync(args, options) { log.push(args); return realGitAdapter.spawnSync(args, options); },
    execFileSync(args, options) { log.push(args); return realGitAdapter.execFileSync(args, options); },
    spawn(args, options) { log.push(args); return realGitAdapter.spawn(args, options); },
  });
}

/** Read the graph of a commit through a module instance, returning it with every Git command it ran. */
async function read(root, commit, instance) {
  const { graphAt } = await import(`../src/io/guards.js?${instance}`);
  const log = [];
  const graph = withGitContractAdapter(recording(log), () => graphAt(root, commit));
  return { graph, commands: log.map(args => args.filter(arg => !arg.startsWith('-') && arg !== 'core.hooksPath=/dev/null')[0]) };
}

/** A graph as plain, comparable data. */
const plain = graph => ({ edges: [...graph.edges].sort(([a], [b]) => (a < b ? -1 : 1)), unknown: graph.unknown.map(row => JSON.stringify(row)).sort() });

test('clause 1: graphAt builds the checkout graph from ls-tree and cat-file and makes no worktree or checkout [C7,#3359]', async t => {
  const { root } = fixture(t);
  const commit = git(root, 'rev-parse', 'HEAD').trim();
  const { graph, commands } = await read(root, commit, 'objects');
  assert.ok(commands.includes('ls-tree') && commands.includes('cat-file'), `the tree and its blobs were read: ${commands}`);
  assert.deepEqual(commands.filter(name => ['worktree', 'checkout', 'clone', 'read-tree', 'archive', 'reset', 'switch'].includes(name)), [], 'no checkout of any kind');
  assert.equal(git(root, 'worktree', 'list').trim().split('\n').length, 1, 'no worktree was added');
  assert.equal(existsSync(join(root, '.git', 'worktrees')), false);
  assert.deepEqual(graph.edges.get('src/cli.js').map(row => row.target), ['src/stats.js', 'src/stats-flow.js']);
  const checkout = cellInventory(root, { importsIn, commonJsIn });
  assert.deepEqual(plain(graph), plain(checkout), 'the same edges and unknown rows as the checkout inventory');
});

test('clause 2: the graph is cached by tree id in the pullboard folder of the git dir, and a second process runs no ls-tree [C7,#3359]', async t => {
  const { root } = fixture(t);
  const commit = git(root, 'rev-parse', 'HEAD').trim(), tree = git(root, 'rev-parse', 'HEAD^{tree}').trim();
  const directory = join(root, '.git', 'pullboard', 'module-graphs'), entry = keyedResultPath(directory, tree);
  const first = await read(root, commit, 'first');
  assert.ok(first.commands.includes('ls-tree'));
  assert.ok(existsSync(entry), 'the graph is stored under its tree id');
  assert.deepEqual(readdirSync(directory).filter(name => !name.endsWith('.result')), [], 'the temporary file was renamed away');
  const second = await read(root, commit, 'second');
  assert.equal(second.commands.includes('ls-tree'), false, `the second process read the cache: ${second.commands}`);
  assert.deepEqual(plain(second.graph), plain(first.graph));
  writeFileSync(entry, 'damaged');
  const third = await read(root, commit, 'third');
  assert.ok(third.commands.includes('ls-tree'), 'a damaged entry is only a miss');
  assert.equal(JSON.parse(readFileSync(entry, 'utf8')).tree, tree, 'and is stored again');
});

test('clause 2: only the newest 32 cached graphs are kept [C7,#3359]', async t => {
  const { root } = fixture(t);
  const commit = git(root, 'rev-parse', 'HEAD').trim(), tree = git(root, 'rev-parse', 'HEAD^{tree}').trim();
  const directory = join(root, '.git', 'pullboard', 'module-graphs'), entry = keyedResultPath(directory, tree);
  await read(root, commit, 'seed');
  for (let index = 0; index < 40; index += 1) {
    const file = keyedResultPath(directory, `old-${index}`);
    writeFileSync(file, '{}');
    utimesSync(file, new Date(2020, 0, 1, 0, 0, index), new Date(2020, 0, 1, 0, 0, index));
  }
  writeFileSync(entry, 'x');
  await read(root, commit, 'prune');
  const names = readdirSync(directory);
  assert.equal(names.length, 32);
  assert.ok(names.includes(basename(entry)), 'the newest entry stays');
});

