/** Shared pieces of the per-item landing journeys: the default-shape project, its items and one settled land [C7,#2901,#5815]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../testkit.js';
import { settleLand } from './settle.js';

/** A landing project with landing.perItem unset, so the default applies. */
export function perItemProject(landProject) {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(box.git(box.repo, 'show', 'HEAD:pullboard.json'));
  delete config.landing.perItem;
  writeFileSync(path, JSON.stringify(config, null, 2));
  box.git(box.repo, 'commit', '-q', '-am', 'chore: per-item landing by default');
  return box;
}

/** Put a passing copy of the red item's file on main, so the landing's base-main comparison can run it [C7,#3065]. */
export function establishBaseFile(box, number, e2e) {
  box.env.LAND_SUPPRESS_RED = '1';
  try { assert.equal(e2e.commitFile(box, box.repo, `web/land-${number}.test.js`, '// PASS\n', 'test(web): establish passing base case [G1]').status, 0); }
  finally { delete box.env.LAND_SUPPRESS_RED; }
}

/** Add, join and claim one item whose check is the fixture's own single-file runner. */
export async function item(box, number) {
  const file = `web/land-${number}.test.js`;
  const path = join(box.dir, `land-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/land-${number}`, path, 'main');
  assert.equal(joinFixtureSeat(box, path, 'web').code, 0);
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: `Land fixture ${number}`,
    criterion: `land fixture ${number} remains valid`, check: `${box.affected} ${file}`, args: ['--specs', 'G1'] }).item_id;
  assert.equal((await box.runLocal(path, 'claim', String(id))).code, 0);
  return { path, item: id, file };
}

/** Point the repository at hooks whose commit-msg refuses every commit, as a strict project hook would on a merge. */
export function refuseEveryCommit(box) {
  const hooks = join(box.dir, 'refusing-hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\necho "commit-msg refuses every commit" >&2\nexit 1\n');
  chmodSync(join(hooks, 'commit-msg'), 0o755);
  box.git(box.repo, 'config', 'core.hooksPath', hooks);
}

/** Offer one plain land and return its settled result: the offer exits 0, the outcome is the land job's receipt [C7,#4265]. */
export async function land(box) {
  const result = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return settleLand(box, JSON.parse(result.out));
}
