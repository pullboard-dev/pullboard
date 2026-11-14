/** Init says out loud when it found no test command, and names the exact step to set one [C7,B26,#7753]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('init in a repo with no test runner says the gate is empty and prints the gate set step [C7,#7753]', async () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'no-runner');
  mkdirSync(join(root, 'src'), { recursive: true });
  box.git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'src', 'app.py'), 'print(1)\n');
  const initialized = await box.runLocal(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  assert.equal(JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).gate, '', 'no command was invented');
  assert.match(initialized.out, /the gate is empty/u);
  assert.match(initialized.out, /pullboard gate set '<command>'/u, 'the exact step, quoted as it should be typed');
  assert.match(initialized.out, /real test command/u, 'a hint that the gate should prove the code');
});

test('init in a repo with a detected test command does not call the gate empty [C7,#7753]', async () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'npm-project');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } }));
  const initialized = await box.runLocal(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  assert.doesNotMatch(initialized.out, /the gate is empty/u);
});
