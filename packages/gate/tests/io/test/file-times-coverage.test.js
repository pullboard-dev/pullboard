/** @pullboard-test-input source-cell gate */
/** The push plan names how many tracked test files have a recorded time, and flags a share under 90 percent [C7,#10330]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureCommitAll } from '../../fixtures/testkit.js';
import { fileTimesCoverage } from '../../../index.js';
import { fileTimesCoverageNote } from '../../../index.js';
import { writeFileTimes } from '../../../index.js';

/** A private git repository whose common dir holds a landing-file-times.json with these files recorded. */
function repo(t, recorded) {
  const box = privateFixtureFiles('pullboard-file-times-coverage-');
  const root = join(box.root, 'repo');
  mkdirSync(root);
  box.write('repo/a.test.js', '\n');
  fixtureCommitAll(root);
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  if (recorded.length) writeFileTimes(root, Object.fromEntries(recorded.map(file => [file, 1000])));
  return root;
}

const FILES = Array.from({ length: 10 }, (_, index) => `t${index}.test.js`);

test('gate.io-test-file-times-coverage.counts-recorded: clause 1: fileTimesCoverage returns the recorded count, the total and the share for a fixture landing-file-times.json [C7,#10330]', (t) => {
  const root = repo(t, [...FILES.slice(0, 4), 'gone.test.js']);
  assert.deepEqual(fileTimesCoverage(root, FILES), { recorded: 4, total: 10, share: 0.4 });
  assert.deepEqual(fileTimesCoverage(root, FILES.map(file => `./${file}`).concat(FILES[0])), { recorded: 4, total: 10, share: 0.4 }, 'a leading ./ is ignored and a repeated file counts once');
  assert.deepEqual(fileTimesCoverage(repo(t, []), FILES), { recorded: 0, total: 10, share: 0 });
  assert.deepEqual(fileTimesCoverage(root, []), { recorded: 0, total: 0, share: 0 }, 'no files give a zero share, never NaN');
});

test('gate.io-test-file-times-coverage.note-flags-under-90: clause 2: the plan note prints recorded N of M files and flags it when under 90 percent [C7,#10330]', (t) => {
  const low = fileTimesCoverageNote(fileTimesCoverage(repo(t, FILES.slice(0, 4)), FILES));
  assert.match(low, /^recorded 4 of 10 files \(40 percent, under 90: the plan is sized from guesses\)$/u);
  const enough = fileTimesCoverageNote(fileTimesCoverage(repo(t, FILES.slice(0, 9)), FILES));
  assert.equal(enough, 'recorded 9 of 10 files', 'exactly 90 percent is not flagged');
  assert.equal(fileTimesCoverageNote({ recorded: 0, total: 0, share: 0 }), 'recorded 0 of 0 files');
});
