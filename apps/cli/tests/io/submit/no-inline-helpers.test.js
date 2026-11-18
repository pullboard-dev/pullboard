/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-world-pin: clause 1 reads the submit command source to prove the inline gate's helpers are gone from it [C7,#6489]. */
/** The submit command defines none of the helpers only the inline gate used; the red-loop guard and head restore the pulled path still runs live in the submit folder [C7,#6489]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SUBMIT = fileURLToPath(new URL('../../../src/io/commands/submit.js', import.meta.url));
const HELPERS = fileURLToPath(new URL('../../../src/io/submit/red-progress.js', import.meta.url));
const NAMES = ['redSubmitTestRuns', 'requireRedSubmitProgress', 'knownMainReds', 'restoreMergedHead'];

/** Whether a source defines a function or constant of this name. */
function defines(source, name) {
  return new RegExp(`(?:function\\s*\\*?\\s*|(?:const|let|var)\\s+)${name}\\b`, 'u').test(source);
}

test('cli.io-submit-no-inline-helpers.apps-cli-src-io-commands-submit-js: clause 1: apps/cli/src/io/commands/submit.js defines none of redSubmitTestRuns, requireRedSubmitProgress, knownMainReds and restoreMergedHead [C7,#6489]', () => {
  const source = readFileSync(SUBMIT, 'utf8');
  assert.deepEqual(NAMES.filter(name => defines(source, name)), [], 'the submit command defines none of the inline gate helpers');
  const moved = readFileSync(HELPERS, 'utf8');
  assert.deepEqual(NAMES.filter(name => !defines(moved, name)), [], 'the helpers the pulled path still calls live in the submit folder');
});
