/** A doctrine hold checks out each main commit once and shares it across its rules [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { baseCheckouts } from '../../src/io/checkouts.js';
import { fixtureCommittedGraph } from '../../../../apps/cli/tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';

/** A private shared clone of the repository at one commit, removed on close, as the hold's own opener makes. */
function openBaseCheckout(root, commit) {
  const files = privateFixtureFiles('doctrine-base-open-'), checkout = join(files.root, 'checkout');
  try {
    runFixtureGit(['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout]);
    runFixtureGit(['checkout', '--quiet', '--detach', commit], { cwd: checkout });
  } catch { return { checkout: null, close: () => rmSync(files.root, { recursive: true, force: true }) }; }
  return { checkout, close: () => rmSync(files.root, { recursive: true, force: true }) };
}

/** A repository with two commits whose `count.txt` differs. */
function repository(t) {
  const graph = fixtureCommittedGraph('doctrine-base-checkouts-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put('count.txt', 'first\n');
  const first = graph.commit();
  graph.put('count.txt', 'second\n');
  const second = graph.commit();
  return { root: graph.root, first, second };
}

/** A rule that reports the checkout it ran in and the committed file it read there. */
function recordingRule(seen) {
  return async (cwd, command) => {
    seen.push(cwd);
    return { problems: [`${command}: ${readFileSync(join(cwd, 'count.txt'), 'utf8').trim()}`], broken: '', seconds: 0 };
  };
}

test('every main-side rule of a hold runs in one checkout of its commit [C7]', async t => {
  const repo = repository(t);
  const seen = [];
  const bases = baseCheckouts(recordingRule(seen), commit => openBaseCheckout(repo.root, commit));
  try {
    const results = [];
    for (const rule of ['C8', 'C9', 'T5', 'T6']) results.push(await bases.run(repo.first, rule, 1000));
    assert.deepEqual(results.map(row => row.problems[0]), ['C8: first', 'C9: first', 'T5: first', 'T6: first']);
    assert.equal(bases.clones(), 1);
    assert.equal(new Set(seen).size, 1);
    assert.equal((await bases.run(repo.second, 'C9', 1000)).problems[0], 'C9: second');
    assert.equal(bases.clones(), 2, 'another commit gets its own checkout');
  } finally { bases.close(); }
});

test('a rule that leaves the checkout dirty makes the next rule clone afresh [C7]', async t => {
  const repo = repository(t);
  const seen = [];
  const record = recordingRule(seen);
  const bases = baseCheckouts(async (cwd, command) => {
    const result = await record(cwd, command);
    if (command === 'writer') writeFileSync(join(cwd, 'stray.js'), 'export {};\n');
    return result;
  }, commit => openBaseCheckout(repo.root, commit));
  try {
    await bases.run(repo.first, 'writer', 1000);
    const next = await bases.run(repo.first, 'reader', 1000);
    assert.equal(next.problems[0], 'reader: first');
    assert.equal(bases.clones(), 2);
    assert.notEqual(seen[0], seen[1]);
    assert.equal(existsSync(join(seen[1], 'stray.js')), false);
  } finally { bases.close(); }
});

test('closing the hold removes its base checkouts even after a rule throws [C7]', async t => {
  const repo = repository(t);
  const seen = [];
  const bases = baseCheckouts(async cwd => { seen.push(cwd); throw new Error('rule failed'); }, commit => openBaseCheckout(repo.root, commit));
  await assert.rejects(bases.run(repo.first, 'C9', 1000), /rule failed/u);
  assert.equal(existsSync(seen[0]), true);
  bases.close();
  assert.equal(existsSync(dirname(seen[0])), false);
});

test('a commit Git cannot check out is reported broken, never counted [C7]', async t => {
  const repo = repository(t);
  const bases = baseCheckouts(async () => assert.fail('no rule runs without a checkout'), commit => openBaseCheckout(repo.root, commit));
  try {
    assert.deepEqual(await bases.run('0'.repeat(40), 'C9', 1000), { problems: [], broken: 'could not check out the base commit', seconds: 0 });
  } finally { bases.close(); }
});
