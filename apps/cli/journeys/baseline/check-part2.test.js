/** Coordinator-owned check commands and explicit caller consent [V2,N23]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeBoard } from '../../../../packages/store/index.js';
import { validateItemAddition } from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';

/** Return the refusal code a check gets from the same validator add and edit use, or null when it passes [C7,V4]. */
function maskRefusal(check) {
  const board = openBoard(':memory:');
  try {
    validateItemAddition(board, { by: 'coordinator', lane: 'core', title: 'Mask probe', criterion: 'the proof passes', route: 'strong', check });
    return null;
  } catch (error) { return error.code; } finally { closeBoard(board); }
}

test('a bare pipefail mention in an echo does not stop a masked pipe being refused [C7,V4]', () => {
  assert.equal(maskRefusal('echo pipefail; node -e "process.exit(1)" | tail -5'), 'CHECK_MASKS_EXIT');
});

test('a check that sets pipefail as a command is accepted [C7,V4]', () => {
  assert.equal(maskRefusal('set -o pipefail; node -e "process.exit(1)" | tail -5'), null);
});

test('a pipe into tail inside a subshell or after an assignment is refused [C7,V4]', () => {
  const masked = `node -e "console.log('proof-red'); process.exit(7)" | tail -n1`;
  // A capture exempts only a pipeline that tests the captured value; this one is never read (#812 review).
  assert.equal(maskRefusal(`out=$(printf ok); ${masked}`), 'CHECK_MASKS_EXIT');
  assert.equal(maskRefusal(`name=value; ${masked}`), 'CHECK_MASKS_EXIT', 'after a plain assignment');
  // A ( ) subshell or { ; } group exits with its last stage, so its pipes count; only $( ) hides them (#812 review).
  assert.equal(maskRefusal(`(${masked})`), 'CHECK_MASKS_EXIT');
  assert.equal(maskRefusal(`{ ${masked}; }`), 'CHECK_MASKS_EXIT');
});

test("the board's own captured-output form is accepted [C7,V4]", () => {
  assert.equal(maskRefusal(`out=$(node apps/cli/src/io/run/tests.js test/x.test.js 2>&1); printf "%s\\n" "$out"; printf "%s\\n" "$out" | grep -Eq "^# fail 0$" && printf "%s\\n" "$out" | grep -Eq "ok"`), null);
  assert.equal(maskRefusal(`out=$(node -e "process.exit(1)" | tail -5); echo "$out" | grep -q ok`), null, 'a pipe inside the capture is not a check pipeline');
});

test('a check that turns pipefail off or sets it conditionally is refused [C7,V4]', () => {
  const masked = `node -e "console.log('proof-red'); process.exit(7)" | tail -n1`;
  // /bin/sh never runs this set, since false fails first, so the pipe still exits 0 (#812 review).
  assert.equal(maskRefusal(`false && set -o pipefail; ${masked}`), 'CHECK_MASKS_EXIT');
  assert.equal(maskRefusal(`set -o pipefail; set +o pipefail; ${masked}`), 'CHECK_MASKS_EXIT', 'a later set +o pipefail turns it off');
  assert.equal(maskRefusal(`(set -o pipefail); ${masked}`), 'CHECK_MASKS_EXIT', 'a subshell keeps its pipefail to itself');
  assert.equal(maskRefusal(`set -euo pipefail; set +eo pipefail; ${masked}`), 'CHECK_MASKS_EXIT', 'a set +o form that clears it');
  assert.equal(maskRefusal(`if true; then set -o pipefail; fi; ${masked}`), 'CHECK_MASKS_EXIT', 'a set inside an if is conditional');
  assert.equal(maskRefusal(`cd .; set -o pipefail; ${masked}`), 'CHECK_MASKS_EXIT', 'pipefail must be the first command');
  assert.equal(maskRefusal(`set -euo pipefail\n${masked}`), null, 'a first-command set that always runs keeps the producer exit');
});

test('a pipe inside a shell comment is not a pipeline [C7,V4]', () => {
  assert.equal(maskRefusal('printf proof-green # example only: false | tail'), null);
  assert.equal(maskRefusal('echo a#b | tail -n1'), 'CHECK_MASKS_EXIT', 'a # inside a word starts no comment');
});
