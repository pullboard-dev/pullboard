/** @pullboard-test-input source-cell gate */
/** The commit hook judges only what the item's diff adds: a ratchet main already exceeds elsewhere never blocks a commit [C7]. */
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';
import { changedStaticFailures } from '../../../../packages/gate/src/io/changed/scripts/static.js';
import { STAGED_TEST_CHECKS } from '../../../../packages/gate/src/io/changed/scripts/static.js';
import { STATIC_CHECKS } from '../../../../packages/gate/src/io/static/check/registry.js';

const cleanups = [];
after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
/** The module-level owner of each cell project's cleanup, for helpers that run outside a test context. */
const owner = { after: cleanup => cleanups.push(cleanup) };

const ROOT = join(import.meta.dirname, '../../../..');
const BASELINE = join(ROOT, 'packages/gate/data/baselines/test-waits-baseline.json');
const LARGE = '// accepted line\n'.repeat(1501);

/** A project whose main already holds one oversized file (the ratchet main exceeds), checked by the real staged-hook checker. */
function projectOverRatchet() {
  const box = cellProject(owner, { gate: 'true' });
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/a-large.js'), LARGE);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: main already over the line cap');
  mkdirSync(join(box.repo, 'packages/gate/data/baselines'), { recursive: true });
  copyFileSync(BASELINE, join(box.repo, 'packages/gate/data/baselines/test-waits-baseline.json'));
  return box;
}

/** Every registered staged check but import-style, whose compile probe needs node --experimental-vm-modules; it judges binding lines, not ratchets. */
const CHECKS = STATIC_CHECKS.map(check => check.name).filter(name => name !== 'import-style');

/** Stage one file and judge the index in process with the hook's staged checks; status 1 and the rows on any failure. */
function stage(box, file, source) {
  writeFileSync(join(box.repo, file), source);
  box.git(box.repo, 'add', file);
  const failures = changedStaticFailures(box.repo, [file], { staged: true, only: CHECKS, also: STAGED_TEST_CHECKS });
  return { status: failures.length ? 1 : 0, stdout: '', stderr: failures.join('\n') };
}

test('clause 1: a commit that touches only file B passes while main already exceeds a ratchet in file A [C7]', () => {
  const box = projectOverRatchet();
  const result = stage(box, 'src/b-small.js', 'export const b = 1;\n');
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('clause 2: a commit that adds a finding in B is still refused, and the file A excess is not named [C7]', () => {
  const box = projectOverRatchet();
  const result = stage(box, 'src/b-large.js', LARGE);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /b-large\.js.*over the 1500-line cap/u);
  assert.doesNotMatch(result.stderr + result.stdout, /a-large\.js/u);
});
