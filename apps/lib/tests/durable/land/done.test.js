/** A landing whose finish sequence wrote publish is marked done and releases its lease [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../cli/tests/fixtures/child.js';
import { openBoard } from '../../../index.js';
import { closeBoard } from '../../../index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { reclaimLapsed } from '../../../../../packages/jobs/index.js';
import { LEASE_MS } from '../../../../../packages/jobs/index.js';
import { landMerged } from '../../../../../packages/land/index.js';
import { mergedLandingJobId } from '../../../../../packages/land/index.js';

/** A repo with a trunk commit and a landed commit on top of it. */
function landedRepo() {
  const files = privateFixtureFiles('pullboard-land-done-repo-');
  const repo = files.root;
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'land@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Land Test']);
  files.write('app.txt', 'trunk\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'trunk']);
  const base = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  files.write('app.txt', 'landed\n');
  runFixtureGit(['-C', repo, 'commit', '-q', '-am', 'landed']);
  return { repo, base, commit: runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']) };
}

test('clause 1: a completed finish sequence ends the job [C7]', async () => {
  const { repo, base, commit } = landedRepo();
  const board = openBoard(':memory:');
  try {
    const id = mergedLandingJobId([7], commit);
    const result = await landMerged(board.db, { repo, ids: [7], commit, base, owner: 'merged:coordinator', now: () => 10_000, record: () => ({ recorded: true }) });
    assert.equal(result.ran.at(-1), 'publish');
    const job = jobView(board.db, id);
    assert.equal(job.step, 'done');
    assert.equal(job.leaseOwner, null);
    assert.equal(job.steps.length, 6, 'done is a mark on the row, not a seventh step');
    assert.deepEqual(reclaimLapsed(board.db, { now: 10_000 + 10 * LEASE_MS }), [], 'the stalled list is empty long after the lease would have lapsed');
  } finally { closeBoard(board); }
});
