/** Composition: a composed slice commit that changes a path outside the slice's set is refused with slices.enforcePaths on [C7,#8809]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/light.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { changedSince } from '../../src/io/submit/preflight.js';
import { requireSlicePaths } from '../../src/io/submit/slice-paths.js';

const item = { item_id: 77 };
/** A board stub holding the slice record `pullboard slice` writes under item-slice:<id>. */
const sliceBoard = files => ({ db: { prepare: () => ({ get: () => ({ meta_value: JSON.stringify({ files }) }), all: () => [] }) } });

/** A real fixture repo: a commit as main, then one composed commit on top that touches `paths`; returns what submit feeds the check. */
function composed(t, paths) {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const root = box.repo;
  const main = box.git(root, 'rev-parse', 'HEAD').trim();
  for (const path of paths) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'changed\n');
  }
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'composed slice');
  return changedSince(root, main, box.git(root, 'rev-parse', 'HEAD').trim());
}

test('clause 1: a composed slice commit changing a path outside the slice set is refused SLICE_PATHS with slices.enforcePaths on [C7,#8809]', t => {
  const changed = composed(t, ['web/view.js', 'api/other.js']);
  const enabled = configFromSource('{"slices":{"enforcePaths":true}}').slices.enforcePaths;
  assert.throws(() => requireSlicePaths(sliceBoard(['web/view.js']), item, changed, enabled), /SLICE_PATHS.*api\/other\.js/u);
  assert.doesNotThrow(() => requireSlicePaths(sliceBoard(['web/view.js']), item, composed(t, ['web/view.js']), enabled));
});

test('clause 2: the same composed commit goes through with the setting at its default (off) [C7,#8809]', t => {
  const changed = composed(t, ['web/view.js', 'api/other.js']);
  const enabled = configFromSource('{}').slices.enforcePaths;
  assert.equal(enabled, false);
  assert.doesNotThrow(() => requireSlicePaths(sliceBoard(['web/view.js']), item, changed, enabled));
});
