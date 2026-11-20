/** A repository after the layout freeze, and changes selected on top of it, shared by the tier selection tests [C7,#4015]. */
import { selectTestTiers } from '../../../../index.js';
import { writeTestTiers } from '../../../../index.js';
import { fixture as repository } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';

export const SIZE_TEST = 'packages/gate/tests/io/size.test.js';
export const OTHER_TEST = 'packages/gate/tests/io/other.test.js';
export const MIXED_TEST = 'packages/gate/tests/io/mixed.test.js';
export const WEB_TEST = 'packages/web/tests/page.test.js';

/**
 * A repository after the layout freeze: one test reaches a size module, one reaches an ordinary gate module, one reaches both,
 * and a web cell stands apart.
 */
export function frozen(t) {
  const { root, put } = repository(t);
  put('packages/gate/data/ceilings/size.json', '{"cap":1500}\n');
  put('packages/gate/src/io/size.js', 'export const size = 1;\n');
  put('packages/gate/src/io/other.js', 'export const other = 1;\n');
  put(SIZE_TEST, "import { size } from '../../src/io/size.js';\nvoid size;\n");
  put(OTHER_TEST, "import { other } from '../../src/io/other.js';\nvoid other;\n");
  put(MIXED_TEST, "import { size } from '../../src/io/size.js';\nimport { other } from '../../src/io/other.js';\nvoid [size, other];\n");
  put('packages/web/src/page.js', 'export const page = 1;\n');
  put(WEB_TEST, "import { page } from '../src/page.js';\nvoid page;\n");
  // The inventory reads tracked files only, so stage the fixture before the manifest is written.
  git(root, 'add', '-A');
  writeTestTiers(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'freeze');
  return { root, put, base: git(root, 'rev-parse', 'HEAD').trim() };
}

/** Commit one change on top of the frozen repository and select its tiers. */
export function change(box, files) {
  for (const [file, source] of Object.entries(files)) box.put(file, source);
  git(box.root, 'add', '-A');
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'change');
  const commit = git(box.root, 'rev-parse', 'HEAD').trim();
  return selectTestTiers(box.root, { base: box.base, commit });
}
