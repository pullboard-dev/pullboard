/** Fixture cleanup removes its folder while a concurrent writer is still finishing, never skipping the removal [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { removeFixtureDirectory } from '../../../../../packages/gate/tests/fixtures/diagnostics.js';

/** A folder whose removal races a writer: the first removal attempt finds a file the writer just added and fails ENOTEMPTY. */
function racedRemoval(directory, racesLeft) {
  let races = racesLeft;
  let attempts = 0;
  const remove = () => {
    attempts++;
    if (races > 0) {
      races--;
      writeFileSync(join(directory, `late-${races}.txt`), 'written by the writer');
      throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY', path: directory });
    }
    rmSync(directory, { recursive: true, force: true });
  };
  return { remove, attempts: () => attempts };
}

test('clause 1: the served-board fixture cleanup of moves.test.js removes its folder while a writer is still adding files [C7]', t => {
  const directory = privateFixtureFiles('pullboard-http-race-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'machine-home'));
  const raced = racedRemoval(directory, 2);
  removeFixtureDirectory(directory, { remove: raced.remove, emit: () => {}, backoff: [1, 1, 1] });
  assert.equal(existsSync(directory), false, 'the folder is removed, not skipped');
  assert.equal(raced.attempts(), 3, 'two writer races were retried within the bounded wait');
});

test('clause 2: the background-writer fixture folder of baseline/check.test.js is removed the same way under a concurrent writer [C7]', t => {
  const directory = privateFixtureFiles('pullboard-writer-race-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const raced = racedRemoval(directory, 1);
  removeFixtureDirectory(directory, { remove: raced.remove, emit: () => {}, backoff: [1, 1, 1] });
  assert.equal(existsSync(directory), false, 'the folder is removed after the writer finished');
  assert.equal(raced.attempts(), 2);
});

test('clause 1: a writer that never stops still fails the removal after the bounded wait, loudly [C7]', t => {
  const directory = privateFixtureFiles('pullboard-writer-stuck-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const raced = racedRemoval(directory, 99);
  const reports = [];
  assert.throws(() => removeFixtureDirectory(directory, { remove: raced.remove, emit: m => reports.push(m), backoff: [1, 1] }), { code: 'ENOTEMPTY' });
  assert.equal(raced.attempts(), 3, 'the wait is bounded by the backoff list');
  assert.equal(reports.length, 1, 'the failure is reported, not swallowed');
});
