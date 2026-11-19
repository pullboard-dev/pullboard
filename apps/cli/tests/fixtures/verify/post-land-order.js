/** The shared seat and offer helpers of the post-land order run files: which item `next --verify` offers a seat of another family [C7,#9864]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureCommandInProcess } from '../process.js';
import { main } from '../native.js';
import { FIXTURE_MODEL } from '../testkit.js';
import { fixtureProjectPolicy } from '../testkit.js';

export const BUILDER = 'Fixture Build Vendor';
export const OTHER = 'Fixture Other Vendor';

/** Join a fresh seat of one family on main and return a runner of the public CLI in it. */
export async function seatOf(box, family) {
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
  const dir = join(box.dir, `post-land-order-${slug}`);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', dir, 'main');
  const cli = (...args) => captureCommandInProcess(main, args, { cwd: dir, env: box.env });
  const joined = await cli('join', 'api', '--family', family, '--model', FIXTURE_MODEL, '--json');
  assert.equal(joined.code, 0, joined.err + joined.out);
  return cli;
}

/** The item id `next --verify` offers a seat, or null when it offers none. */
export async function offeredTo(cli) {
  const result = await cli('next', '--verify', '--json');
  try { return JSON.parse(result.out).item?.item_id ?? null; } catch { return null; }
}

/** Commit verify.landedReviews on with verify.family require to the box's main. */
export function offerLandedReviews(box) {
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, verify: { ...config.verify, landedReviews: true, family: 'require' } } });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: offer landed reviews to another family');
}
