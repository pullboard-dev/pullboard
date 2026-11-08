/** A content conflict Git reports reaches reopen --conflict even when landing could resolve it mechanically [B3,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { requireTrunkConflict, trunkMerge } from '../packages/merge/index.js';
import { createE2eHelpers, FIXTURE_MODEL } from './e2e-helpers.js';
import { fixtureAdd } from './testkit-fixture.js';

process.env.PULLBOARD_MODEL ??= FIXTURE_MODEL;

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project, commitFile } = e2e;

/** Commit one file on the current branch of a checkout and return the new commit. */
function commit(box, cwd, file, text, subject) {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  const done = commitFile(box, cwd, file, text, subject);
  assert.equal(done.status, 0, done.stderr);
  return box.git(cwd, 'rev-parse', 'HEAD');
}

test('clause 1: a content conflict git reports is a conflict [C7]', () => {
  const box = project();
  commit(box, box.repo, 'imports.js', "import a from './a.js';\n\nexport const x = 1;\n", 'feat(web): base imports [G1]');
  box.git(box.repo, 'switch', '-q', '-c', 'side');
  const side = commit(box, box.repo, 'imports.js', "import a from './a.js';\nimport b from './b.js';\n\nexport const x = 1;\n", 'feat(web): side adds b [G1]');
  box.git(box.repo, 'switch', '-q', 'main');
  commit(box, box.repo, 'imports.js', "import a from './a.js';\nimport c from './c.js';\n\nexport const x = 1;\n", 'feat(web): trunk adds c [G1]');
  assert.equal(trunkMerge(box.repo, side).files, null, 'landing still treats the mechanically resolvable additions as clean');
  const merge = trunkMerge(box.repo, side, undefined, { raw: true });
  assert.deepEqual(merge.files, ['imports.js'], 'trunkMerge names the file Git reports');
  const found = requireTrunkConflict(commitId => trunkMerge(box.repo, commitId, undefined, { raw: true }), side, ['imports.js']);
  assert.deepEqual(found.files, ['imports.js']);
  assert.equal(found.trunk, merge.commit);
});

test('clause 1: reopen --conflict returns an accepted item whose merge git reports as a content conflict [C7]', () => {
  const box = project();
  commit(box, box.repo, 'web/feature.js', "import a from './a.js';\n\nexport const x = 1;\n", 'feat(web): base imports [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Imports item', '--specs', 'G1', '--criterion', 'The imports item stays valid', '--check', 'node --check web/feature.js', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0);
  const itemCommit = commit(box, box.web, 'web/feature.js', "import a from './a.js';\nimport b from './b.js';\n\nexport const x = 1;\n", 'feat(web): item adds b [G1]');
  const submitted = box.run(box.web, 'submit', String(id));
  assert.equal(submitted.code, 0, submitted.err);
  box.git(box.repo, 'switch', '-q', '--detach', itemCommit);
  try {
    const accepted = box.run(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'ran the frozen check at the submitted commit');
    assert.equal(accepted.code, 0, accepted.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  const trunk = commit(box, box.repo, 'web/feature.js', "import a from './a.js';\nimport c from './c.js';\n\nexport const x = 1;\n", 'feat(web): trunk adds c [G1]');
  const reopened = box.run(box.repo, 'reopen', String(id), '--conflict', 'web/feature.js', '--json');
  assert.equal(reopened.code, 0, [reopened.out, reopened.err].join('\n'));
  assert.deepEqual(JSON.parse(reopened.out).conflict, { files: ['web/feature.js'], trunk }, 'the command names the file git reports and the trunk commit');
  const shown = box.run(box.repo, 'show', String(id));
  assert.match(shown.out, new RegExp(`^#${id}  open \\(needs main merge\\)`, 'mu'), 'the item is returned to its builder, not refused NOT_CONFLICTING');
});
