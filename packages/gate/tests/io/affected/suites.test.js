/** A repo declares which suite covers each folder, so a polyglot landing runs only the suites its changes reach [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../fixtures/child.js';
import { temporaryRepository } from '../../../../store/tests/fixtures/submit.js';
import { selectAffectedTests } from '../../../index.js';

const SUITES = { 'api/**': 'api/tests', 'web/**': 'web/test', 'ops/**': 'ops/test' };

/** A real repository with a PHP-style api/ and a web/ folder, a base commit, and a candidate branch. */
function repository(t) {
  const root = temporaryRepository(t, 'pullboard-suites-');
  const git = (...args) => runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root });
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  put('api/src/Handler.php', '<?php\n');
  put('web/app/page.tsx', 'export default 1;\n');
  put('README.md', 'x\n');
  git('add', '-A'); git('commit', '-qm', 'chore: fixture');
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-qb', 'candidate');
  return { root, base, put, commit: () => { git('add', '-A'); git('commit', '-qm', 'candidate'); } };
}

test('clause 1: a change under api/ passes only the api suite, and two folders pass both suites [C7]', t => {
  const box = repository(t);
  box.put('api/src/Handler.php', '<?php // changed\n');
  box.commit();
  const one = selectAffectedTests(box.root, { base: box.base, suites: SUITES });
  assert.deepEqual({ full: one.full, files: one.files }, { full: false, files: ['api/tests'] });
  box.put('web/app/page.tsx', 'export default 2;\n');
  box.commit();
  const two = selectAffectedTests(box.root, { base: box.base, suites: SUITES });
  assert.deepEqual({ full: two.full, files: two.files }, { full: false, files: ['api/tests', 'web/test'] });
});

test('clause 2: a changed path no glob covers makes the landing run the full gate, naming the path [C7]', t => {
  const box = repository(t);
  box.put('api/src/Handler.php', '<?php // changed\n');
  box.put('README.md', 'changed\n');
  box.commit();
  const result = selectAffectedTests(box.root, { base: box.base, suites: SUITES });
  assert.equal(result.full, true);
  assert.match(result.reason, /no affectedSuites glob covers README\.md/u);
});

test('clause 3: with no affectedSuites key selection is exactly as before [C7]', t => {
  const box = repository(t);
  box.put('api/src/Handler.php', '<?php // changed\n');
  box.commit();
  const plain = selectAffectedTests(box.root, { base: box.base });
  const empty = selectAffectedTests(box.root, { base: box.base, suites: {} });
  assert.deepEqual(empty, plain);
  assert.doesNotMatch(plain.reason, /affectedSuites/u);
  assert.equal(plain.full, true, 'a repo with no Node tests still runs the full gate');
});
