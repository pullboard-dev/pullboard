/** Fixture helpers for the cells-stage cache journeys: a fresh runner-job checkout and one commit on top of a base [C7]. */
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { temporaryDirectory } from '../board.js';
import { git } from '../../../../../packages/landing/tests/fixtures/plan.js';

/** Clone a repository into a fresh folder, the way each runner job starts from its own checkout. */
export function freshJob(t, root) {
  const parent = temporaryDirectory('pullboard-cells-job-');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const checkout = join(parent, 'job');
  git(parent, 'clone', '-q', '--shared', root, checkout);
  return checkout;
}

/** Commit one edit on top of a commit in a job checkout and leave it checked out; returns the new commit. */
export function commitOn(job, base, file, text, message) {
  git(job, 'checkout', '-q', '--detach', base);
  mkdirSync(dirname(join(job, file)), { recursive: true });
  writeFileSync(join(job, file), text);
  git(job, 'add', '-A');
  git(job, 'commit', '-q', '-m', message);
  return git(job, 'rev-parse', 'HEAD').trim();
}
