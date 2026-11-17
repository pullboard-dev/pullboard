/** A trusted re-check of a commit range names secrets and header breaks whatever hooks were skipped [C1,C2]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureCommittedGraph } from '../../../gate/tests/fixtures/testkit.js';
import { runFixtureSetupGit } from '../../../gate/tests/fixtures/child.js';
import { recheckRange } from '../../index.js';

const IDENTITY = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
  GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };

/** A real repo with one base commit; `commit(path, body, message)` adds one more, as a hook-skipping author could. */
function fixture(t) {
  const graph = fixtureCommittedGraph('pullboard-recheck-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  const git = (...args) => runFixtureSetupGit(args, { cwd: graph.root, env: { ...process.env, ...IDENTITY } });
  graph.put('readme.txt', 'base\n');
  const base = graph.commit();
  return {
    root: graph.root, base,
    commit(path, body, message) {
      graph.put(path, body);
      git('add', '-A');
      git('commit', '-qm', message);
      return git('rev-parse', 'HEAD');
    },
    head: () => git('rev-parse', 'HEAD'),
  };
}

test('commits.io-recheck.clause-1-a-commit-that-skipped-its-hooks: clause 1: a commit that skipped its hooks and adds an assigned secret is named by the re-check of its range [C1]', t => {
  const repo = fixture(t);
  // Built from parts so this file never holds a secret-shaped line itself.
  const value = ['abcd', 'efgh', 'ijkl', 'mnop', 'qrst'].join('');
  const bad = repo.commit('config.js', `export const apiKey = '${value}';\n`, 'fix(config): add a key [G1.1]');
  const found = recheckRange(repo.root, repo.base, repo.head());
  assert.deepEqual(found.map(f => [f.commit, f.kind]), [[bad, 'secret']]);
  assert.match(found[0].problem, /assigned secret at config\.js:1/u);
  assert.ok(!found[0].problem.includes(value), 'the value is never echoed');
});

test('commits.io-recheck.clause-2-a-range-whose-commit-header: clause 2: a range whose commit header breaks the header rule is named by the re-check [C2]', t => {
  const repo = fixture(t);
  const bad = repo.commit('notes.txt', 'hello\n', 'Added some notes.');
  const long = repo.commit('more.txt', 'more\n', `docs(notes): ${'a'.repeat(70)}`);
  const found = recheckRange(repo.root, repo.base, repo.head());
  assert.deepEqual(found.map(f => [f.commit, f.kind]), [[bad, 'header'], [long, 'header']]);
  assert.match(found[0].problem, /write the header as type\(scope\): subject/u);
  assert.match(found[1].problem, /shorten the header to 72 characters/u);
});

test('commits.io-recheck.clause-3-a-clean-range-returns-no: clause 3: a clean range returns no findings [C1,C2]', t => {
  const repo = fixture(t);
  repo.commit('notes.txt', 'hello\n', 'docs(notes): add notes');
  assert.deepEqual(recheckRange(repo.root, repo.base, repo.head()), []);
  assert.deepEqual(recheckRange(repo.root, repo.head(), repo.head()), []);
});
