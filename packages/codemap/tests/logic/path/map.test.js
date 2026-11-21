/** @pullboard-test-input source-cell packages/codemap */
/** Committed and snapshot path maps retain their complete identity contract [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles, runFixtureSetupGit } from '../../../../../gate/tests/fixtures/child.js';
import {
  historicalPaths,
  historyPathMap,
  mappedCause,
  mappedCheck,
  pathAtCommit,
  pathMapFromFiles,
  readPathMap,
} from '../../../../src/logic/path/map.js';

/** Create a real Git repository with committed path-map inputs. */
function repository(t, files = {}) {
  const { root, write } = privateFixtureFiles('pullboard-path-map-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Path map fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Path map fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  runFixtureSetupGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  for (const [file, value] of Object.entries(files)) write(file, value);
  if (Object.keys(files).length) {
    runFixtureSetupGit(['add', '--all'], { cwd: root, env });
    runFixtureSetupGit(['commit', '-qm', 'record path map'], { cwd: root, env });
  }
  return { root, env, write };
}

/** Serialize a path map as a committed shard. */
const shard = (name, map) => [`packages/codemap/data/plan/path-map/${name}.json`, `${JSON.stringify(map)}\n`];

test('codemap.logic-path-map.committed-shards-retained: clause 1: two committed shards without a root map flatten chains and preserve historical aliases, checks, causes and main history [C7]', t => {
  const { root } = repository(t, Object.fromEntries([
    shard('alpha', { 'src/old.js': 'src/moved.js', 'src/other.js': 'packages/app/current.js' }),
    shard('beta', { 'src/moved.js': 'packages/app/current.js' }),
    ['packages/app/current.js', 'export const current = true;\n'],
  ]));
  const map = readPathMap(root);
  assert.deepEqual([...map], [
    ['src/old.js', 'packages/app/current.js'],
    ['src/other.js', 'packages/app/current.js'],
    ['src/moved.js', 'packages/app/current.js'],
  ]);
  assert.deepEqual(historyPathMap(root), map);
  assert.deepEqual(historicalPaths(map, 'packages/app/current.js'), [
    'packages/app/current.js', 'src/old.js', 'src/other.js', 'src/moved.js',
  ]);
  assert.equal(pathAtCommit(root, map, 'src/old.js', 'HEAD'), 'packages/app/current.js');
  assert.equal(mappedCheck(root, 'node --test src/old.js "src/old.js prose"'), "node --test 'packages/app/current.js' \"src/old.js prose\"");
  assert.equal(mappedCause(map, 'test:src/old.js::case.one'), 'test:packages/app/current.js::case.one');
});

test('codemap.logic-path-map.snapshot-shards-retained: clause 1: snapshot shards and the root compatibility map are both read while nonregular entries refuse [C7]', t => {
  const files = new Map([
    ['path-map.json', Buffer.from(JSON.stringify({ 'src/root.js': 'packages/app/root.js' }))],
    ['packages/codemap/data/plan/path-map/alpha.json', Buffer.from(JSON.stringify({ 'src/alpha.js': 'packages/app/alpha.js' }))],
  ]);
  const entries = new Map([...files.keys()].map(path => [path, { mode: '100644' }]));
  assert.deepEqual([...pathMapFromFiles(files, entries)], [
    ['src/alpha.js', 'packages/app/alpha.js'], ['src/root.js', 'packages/app/root.js'],
  ]);
  entries.set('packages/codemap/data/plan/path-map/alpha.json', { mode: '120000' });
  assert.throws(() => pathMapFromFiles(files, entries), error => error.code === 'NO_POLICY');
});

test('codemap.logic-path-map.invalid-map-refuses: clause 1: invalid JSON, duplicate shard keys, cycles and unsafe paths refuse with NO_POLICY [C7]', t => {
  const invalid = [
    { 'packages/codemap/data/plan/path-map/alpha.json': '{' },
    Object.fromEntries([shard('alpha', { 'src/old.js': 'src/new.js' }), shard('beta', { 'src/old.js': 'packages/app/new.js' })]),
    Object.fromEntries([shard('alpha', { 'src/old.js': 'src/new.js', 'src/new.js': 'src/old.js' })]),
    Object.fromEntries([shard('alpha', { '../outside.js': 'packages/app/new.js' })]),
  ];
  for (const files of invalid) assert.throws(() => readPathMap(repository(t, files).root), error => error.code === 'NO_POLICY');
});

test('codemap.logic-path-map.empty-only-when-absent: clause 1: an empty map is returned only when neither root nor shard source exists [C7]', t => {
  assert.equal(readPathMap(repository(t).root).size, 0);
  assert.deepEqual([...readPathMap(repository(t, {
    'path-map.json': JSON.stringify({ 'src/old.js': 'packages/app/new.js' }),
  }).root)], [['src/old.js', 'packages/app/new.js']]);
});
