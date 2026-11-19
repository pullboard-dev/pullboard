/** The static run at main's commit returns main's findings from a throwaway checkout it removes [C7,#10449]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { staticFindingsOnMain } from '../../../src/io/static/main-findings.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { fixtureCommitAll } from '../../fixtures/testkit.js';

/** The one main-checkout helper's shape: a clean detached clone at `commit`, handed to `run` and always removed (the landing cell owns the real one). */
async function withMainCheckout(root, commit, run) {
  const { root: folder } = privateFixtureFiles('pullboard-main-findings-checkout-');
  const checkout = join(folder, 'checkout');
  try {
    runFixtureGit(['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout], { cwd: folder });
    runFixtureGit(['checkout', '--quiet', '--force', '--detach', commit], { cwd: checkout });
    return await run(checkout);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

/** A repository with one commit whose tracked check script prints `lines` and exits `status`; returns its root, commit and git. */
function repoWithCheck(lines, status) {
  const { root } = privateFixtureFiles('pullboard-main-findings-');
  writeFileSync(join(root, 'check.sh'), `${lines.map(line => `echo '${line}'`).join('\n')}\nexit ${status}\n`);
  fixtureCommitAll(root);
  const git = (...args) => runFixtureGit(args, { cwd: root }).trim();
  return { root, commit: git('rev-parse', 'HEAD'), git };
}

test('gate.io-static-main-findings.runs-static-in-a-throwaway-checkout: clause 1: staticFindingsOnMain runs the static command in a throwaway checkout at main\'s commit, returns its findings, and removes the checkout [C7,#10449]', async () => {
  const { root, commit, git } = repoWithCheck(['STATIC_RED packages/a/x.js:3: runs a git fetch outside the one entry point [C7]', 'packages/b/y.js:9: 12 tests over the ratchet of 11'], 1);
  writeFileSync(join(root, 'dirty.txt'), 'uncommitted\n');
  const seen = [];
  const found = await staticFindingsOnMain(root, { staticChecks: 'sh check.sh' }, commit, {
    withMainCheckout: (from, at, run) => withMainCheckout(from, at, checkout => {
      seen.push(checkout);
      assert.notEqual(checkout, root);
      assert.equal(existsSync(join(checkout, 'dirty.txt')), false, 'the checkout holds main\'s commit alone');
      return run(checkout);
    }),
  });
  assert.deepEqual(found, [
    { rule: '# tests over the ratchet of #', file: 'packages/b/y.js' },
    { rule: 'runs a git fetch outside the one entry point', file: 'packages/a/x.js' },
  ]);
  assert.equal(seen.length, 1);
  assert.equal(existsSync(seen[0]), false, 'the checkout is gone afterwards');
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'the repository itself is untouched');
});

test('gate.io-static-main-findings.green-main-returns-no-findings: clause 2: a green main run returns an empty list, and a main without a static command returns an empty list [C7,#10449]', async () => {
  const { root, commit } = repoWithCheck(['static style, prose declarations, clock budgets and doctrine hold'], 0);
  assert.deepEqual(await staticFindingsOnMain(root, { staticChecks: 'sh check.sh' }, commit, { withMainCheckout }), []);
  assert.deepEqual(await staticFindingsOnMain(root, { staticChecks: '' }, commit, { withMainCheckout }), []);
});
