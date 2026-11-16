/** Registry guard policy validation and selection stay in config, with no CLI [C7,V4,V16]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { git } from '../../../git/index.js';
import { selectRegistryGuards } from '../../../kernel/index.js';
import { configFromSource } from '../../index.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../gate/tests/fixtures/testkit.js';

/** A private plain Git repository on a `web` branch holding one registered move input, with no board, hooks or CLI. */
function registryRepo(t) {
  const graph = fixtureCommittedGraph('pullboard-registry-guards-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put('src/moves/known.js', 'export const operation = "known";\n');
  graph.put('web/item.test.js', "import { test } from 'node:test';\ntest('item works [G1]', () => {});\n");
  graph.commit();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  /** Run real Git in this repository with only the fixture's identity. */
  const run = (...args) => runFixtureGit(args, { cwd: graph.root, env });
  run('checkout', '-q', '-b', 'web');
  return { root: graph.root, git: run, commit: message => { run('add', '-A'); run('commit', '-q', '-m', message); } };
}

test('registry policy validates paths and selects deleted and renamed inputs conservatively [C7,V4]', t => {
  assert.deepEqual(configFromSource('{"gate":"true"}').registryGuards, [], 'other projects opt in explicitly');
  for (const path of ['../outside.js', '/absolute.js', 'test/*.js', 'test/../outside.js']) {
    assert.throws(() => configFromSource(JSON.stringify({ affectedTests: 'custom-runner', registryGuards: [{ inputs: ['src/**'], tests: [path] }] })),
      error => error.code === 'BAD_CONFIG' && error.message.includes('registryGuards'));
  }
  const box = registryRepo(t);
  const base = box.git('rev-parse', 'HEAD').trim();
  const rules = [{ inputs: ['src/moves/**'], tests: ['apps/cli/journeys/relay/credential.test.js'] }];
  assert.deepEqual(selectRegistryGuards(box.root, rules, { base, changed: ['web/unrelated.js'] }), []);
  box.git('mv', 'src/moves/known.js', 'web/renamed.js');
  box.commit('chore: rename the fixture move out of its registry');
  assert.deepEqual(selectRegistryGuards(box.root, rules, { base, git }), ['apps/cli/journeys/relay/credential.test.js']);
  assert.deepEqual(selectRegistryGuards(box.root, rules, { trunk: 'main', changed: ['web/unrelated.js'], git }),
    ['apps/cli/journeys/relay/credential.test.js'], 'the real trunk merge base overrides caller-supplied changes');
  const renamedOut = box.git('rev-parse', 'HEAD').trim();
  box.git('mv', 'web/renamed.js', 'src/moves/renamed.js');
  box.commit('chore: rename the fixture move into its registry');
  assert.deepEqual(selectRegistryGuards(box.root, rules, { base: renamedOut, git }), ['apps/cli/journeys/relay/credential.test.js']);
  const beforeDelete = box.git('rev-parse', 'HEAD').trim();
  box.git('rm', 'src/moves/renamed.js');
  box.commit('chore: delete the fixture registry input');
  assert.deepEqual(selectRegistryGuards(box.root, rules, { base: beforeDelete, git }), ['apps/cli/journeys/relay/credential.test.js']);
  assert.deepEqual(selectRegistryGuards(box.root, rules, { base, changed: ['src/moves/deleted.js'] }), ['apps/cli/journeys/relay/credential.test.js']);
  assert.deepEqual(selectRegistryGuards(box.root, rules), ['apps/cli/journeys/relay/credential.test.js'], 'an unknown base retains every obligation');
});


test('registry selection uses the explicit caller Git port and never queries for supplied changes or uncertainty [C7,D3]', () => {
  const rules = [{ inputs: ['src/moves/**'], tests: ['test/registry.test.js'] }];
  const calls = [];
  const provider = (root, args) => {
    calls.push({ root, args });
    if (args[0] === 'merge-base') return 'base\n';
    if (args[0] === 'rev-parse') return 'head\n';
    assert.deepEqual(args, ['diff', '--no-renames', '--name-only', '-z', 'base', 'tip']);
    return 'src/moves/deleted.js\0web/renamed.js\0';
  };
  assert.deepEqual(selectRegistryGuards('/fixture', rules, {
    trunk: 'accepted', commit: 'tip', changed: ['web/irrelevant.js'], git: provider,
  }), ['test/registry.test.js']);
  assert.deepEqual(calls, [
    { root: '/fixture', args: ['merge-base', 'accepted', 'tip'] },
    { root: '/fixture', args: ['rev-parse', '--verify', 'tip^{commit}'] },
    { root: '/fixture', args: ['diff', '--no-renames', '--name-only', '-z', 'base', 'tip'] },
  ], 'trunk selection recomputes committed changes through the supplied provider');
  const forbidden = () => { throw new Error('no Git query is needed'); };
  assert.deepEqual(selectRegistryGuards('/fixture', rules, { base: 'base', changed: ['web/irrelevant.js'], git: forbidden }), []);
  assert.deepEqual(selectRegistryGuards('/fixture', rules, { git: forbidden }), ['test/registry.test.js']);
  assert.deepEqual(selectRegistryGuards('/fixture', [], { base: 'base', git: forbidden }), []);
  const failure = new Error('the caller Git operation refused');
  assert.throws(() => selectRegistryGuards('/fixture', rules, { base: 'base', git: () => { throw failure; } }),
    error => error === failure, 'provider failures propagate unchanged');
});
