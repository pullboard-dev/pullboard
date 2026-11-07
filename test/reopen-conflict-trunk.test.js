/** A content conflict Git reports reaches reopen --conflict even when landing could resolve it mechanically [B3,C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { requireTrunkConflict, trunkMerge } from '../packages/merge/index.js';
import { createE2eHelpers } from './e2e-helpers.js';

process.env.PULLBOARD_MODEL ??= 'Test Model';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project, commitFile } = e2e;

/** Commit one file on the current branch of a checkout and return the new commit. */
function commit(box, cwd, file, text, subject) {
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
