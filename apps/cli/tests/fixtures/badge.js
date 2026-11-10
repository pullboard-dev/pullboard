/** Real landing proof for board-derived badge endpoint commits [B3,V1,R3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureAdd } from './testkit.js';
import { fixtureJoin } from './testkit.js';

/** Require both documents in the exact landed, clean tip of a real private project's complete lifecycle. */
export function assertBadgeLanding(e2e) {
  // The project's own web seat joins as the fixture model and a rejoin cannot change a seat's model or parent, so this
  // landing creates its web worktree unjoined and joins it once with the builder identity.
  const bare = e2e.project('node --test web/badge.test.cjs', undefined, { withWorktree: false });
  const web = join(bare.dir, 'web-1');
  bare.git(bare.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const box = { ...bare, web };
  const builder = fixtureJoin(box.run, box.web, 'web', '--model', 'Badge fixture', '--parent', 'badge-parent-P');
  assert.equal(builder.code, 0, builder.err);
  const reviewer = fixtureJoin(box.run, box.repo, 'coordinator', '--model', 'Badge fixture', '--parent', 'badge-parent-Q');
  assert.equal(reviewer.code, 0, reviewer.err);
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { perItem: false, manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure private badge landing');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Badge landing', '--criterion', 'The native probe passes.', '--check', 'node --test web/badge.test.cjs', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.err);
  const committed = e2e.commitFile(box, box.web, 'web/badge.test.cjs', "const { test } = require('node:test'); test('the badge landing probe passes [G1]', () => {});\n", 'test(web): add private badge landing probe [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const submitted = box.run(box.web, 'submit', String(id));
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    const accepted = box.run(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'The private native probe passed at the submitted commit.');
    assert.equal(accepted.code, 0, `${accepted.err}\n${accepted.out}`);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  const beforeLanding = box.git(box.repo, 'rev-parse', 'main');
  const result = box.run(box.repo, 'land', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const landed = JSON.parse(result.out);
  assert.deepEqual(landed.landed, [id]);
  const recorded = JSON.parse(box.run(box.repo, 'show', String(id), '--json').out);
  assert.equal(recorded.item_merged_commit, landed.batch.tip, 'badge refresh remains inside the first-containing item merge');
  assert.deepEqual(box.git(box.repo, 'rev-list', '--parents', '-n', '1', landed.batch.tip).split(' '),
    [landed.batch.tip, beforeLanding, commit], 'the badge refresh preserves both actual merge parents');
  assert.equal(box.git(box.repo, 'log', '-1', '--format=%b', landed.batch.tip).trim(), `Pullboard-Item: #${id}`);

  const documents = ['items', 'checked'].map(name => JSON.parse(box.git(box.repo, 'show', `${landed.batch.tip}:docs/badges/${name}.json`)));
  assert.equal(documents[0].message, '1 items');
  assert.equal(documents[1].message, '100%');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), landed.batch.tip);
  assert.equal(box.git(box.repo, 'status', '--porcelain'), '', 'the endpoint refresh is committed with the landed tip');
}
