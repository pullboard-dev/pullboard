/** @pullboard-test-input apps/cli/src/io/commands/new.js apps/cli/src/logic/new-package.js apps/cli/tests/fixtures/e2e.js */
/** pullboard new package writes the files newPackageFiles returns under packages/<name>, and refuses an existing folder or a bad first word [C7,#11426]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { newPackageFiles } from '../../../src/logic/new-package.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('cli.io-commands-new.writes-anatomy-files: clause 1: new package <name> --purpose writes exactly the files newPackageFiles returns under packages/<name> and prints each path [C7,#11426]', async () => {
  const box = e2e.project();
  const expected = newPackageFiles('tidy-cell', 'keeps the shelves tidy');
  const made = await box.runLocal(box.repo, 'new', 'package', 'tidy-cell', '--purpose', 'keeps the shelves tidy');
  assert.equal(made.code, 0, made.err || made.out);
  for (const [path, text] of Object.entries(expected)) {
    assert.equal(readFileSync(join(box.repo, path), 'utf8'), text, path);
    assert.ok(made.out.split('\n').includes(path), `prints ${path}`);
  }
});

test('cli.io-commands-new.refuses-existing-package: clause 2: new package refuses NEW_PACKAGE_EXISTS and writes nothing when packages/<name> already exists [C7,#11426]', async () => {
  const box = e2e.project();
  await box.runLocal(box.repo, 'new', 'package', 'tidy-cell', '--purpose', 'keeps the shelves tidy');
  const spare = Object.keys(newPackageFiles('tidy-cell', 'x'))[0];
  const before = readFileSync(join(box.repo, spare), 'utf8');
  const again = await box.runLocal(box.repo, 'new', 'package', 'tidy-cell', '--purpose', 'a different purpose');
  assert.notEqual(again.code, 0);
  assert.match(again.err + again.out, /NEW_PACKAGE_EXISTS/u);
  assert.equal(readFileSync(join(box.repo, spare), 'utf8'), before, 'the existing file is untouched');
});

test('cli.io-commands-new.refuses-bad-usage: clause 3: new refuses USAGE for a first word other than package, or with no name [C7,#11426]', async () => {
  const box = e2e.project();
  for (const args of [['widget', 'tidy-cell'], ['package']]) {
    const refused = await box.runLocal(box.repo, 'new', ...args, '--purpose', 'x');
    assert.notEqual(refused.code, 0);
    assert.match(refused.err + refused.out, /USAGE/u);
  }
  assert.equal(existsSync(join(box.repo, 'packages', 'tidy-cell')), false);
});
