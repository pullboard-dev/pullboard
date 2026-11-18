/** next --verify offers a forced landing without a verdict only to a seat of another model family [C7,#9863]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureCommandInProcess } from '../../tests/fixtures/process.js';
import { main } from '../../tests/fixtures/native.js';
import { fixture } from '../../tests/fixtures/land/failure.js';
import { landedBy } from '../../tests/fixtures/land/failure.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';

const BUILDER = 'Fixture Build Vendor';
const OTHER = 'Fixture Other Vendor';

/** A forced landing built by BUILDER, with verify.landedReviews on and verify.family require committed to main; returns the box and item. */
async function landedUnderFamilyRule(t) {
  const box = await fixture(t);
  const item = await landedBy(box, t, { family: BUILDER });
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, verify: { ...config.verify, landedReviews: true, family: 'require' } } });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: offer landed reviews to another family');
  return { box, item };
}

/** Join a fresh seat of one family on main and return a runner of the public CLI in it. */
async function seatOf(box, family) {
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
  const dir = join(box.dir, `post-land-${slug}`);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', dir, 'main');
  const cli = (...args) => captureCommandInProcess(main, args, { cwd: dir, env: box.env });
  const joined = await cli('join', 'api', '--family', family, '--model', FIXTURE_MODEL, '--json');
  assert.equal(joined.code, 0, joined.err + joined.out);
  return cli;
}

/** The item id `next --verify` offers a seat, or null when it offers none. */
async function offeredTo(cli) {
  const result = await cli('next', '--verify', '--json');
  try { return JSON.parse(result.out).item?.item_id ?? null; } catch { return null; }
}

test('cli.journeys-verify-post-land-family.with-verify-landedreviews-and-verify-family: clause 1: with verify.landedReviews and verify.family require, next --verify offers a forced landing without a verdict to a seat of another model family [C7,#9863]', async t => {
  const { box, item } = await landedUnderFamilyRule(t);
  const other = await seatOf(box, OTHER);
  assert.equal(await offeredTo(other), item);
});
