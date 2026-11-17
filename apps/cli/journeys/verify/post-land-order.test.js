/** next --verify offers a submitted item before any landed one, and landed items newest landing first [C7,#9864]. */
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

/** Join a fresh seat of one family on main and return a runner of the public CLI in it. */
async function seatOf(box, family) {
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
  const dir = join(box.dir, `post-land-order-${slug}`);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', dir, 'main');
  const cli = (...args) => captureCommandInProcess(main, args, { cwd: dir, env: box.env });
  const joined = await cli('join', 'api', '--family', family, '--model', FIXTURE_MODEL, '--json');
  assert.equal(joined.code, 0, joined.err + joined.out);
  return cli;
}

/** The item id `next --verify` offers a seat, or null when it offers none. */
async function offeredTo(cli) {
  const result = await cli('next', '--verify', '--json');
  try { return JSON.parse(result.out).item?.item_id ?? `none: ${result.out}${result.err}`.slice(0, 600); } catch { return `unparsed: ${result.out}${result.err}`.slice(0, 600); }
}

/** Commit verify.landedReviews on with verify.family require to the box's main. */
function offerLandedReviews(box) {
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, verify: { ...config.verify, landedReviews: true, family: 'require' } } });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: offer landed reviews to another family');
}
test('clause 1: with landed reviews on, a submitted item is offered before any landed item [C7,#9864]', async t => {
  const box = await fixture(t);
  await landedBy(box, t, { family: `${BUILDER} A`, name: 'Landed older' });
  const newer = await landedBy(box, t, { family: `${BUILDER} B`, name: 'Landed newer' });
  const submitted = await landedBy(box, t, { family: `${BUILDER} C`, name: 'Submitted, not landed', land: false });
  offerLandedReviews(box);
  const other = await seatOf(box, OTHER);
  assert.equal(await offeredTo(other), submitted, 'the submitted item comes before every landed item');
  const accepted = await other('verify', String(submitted), 'accept', '--no-next', '--note', 'read the diff against the bar', '--json');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  assert.equal(await offeredTo(other), newer, 'the newest landed item is offered once no submitted item waits');
});

test('clause 2: two landed items are offered newest landing first [C7,#9864]', async t => {
  const box = await fixture(t);
  const older = await landedBy(box, t, { family: `${BUILDER} A`, name: 'Landed older' });
  const newer = await landedBy(box, t, { family: `${BUILDER} B`, name: 'Landed newer' });
  offerLandedReviews(box);
  const other = await seatOf(box, OTHER);
  assert.equal(await offeredTo(other), newer, 'the newest landing is offered first');
  const accepted = await other('verify', String(newer), 'accept', '--no-next', '--note', 'read the merge diff against the bar', '--json');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  assert.equal(await offeredTo(other), older, 'the older landing follows');
});
