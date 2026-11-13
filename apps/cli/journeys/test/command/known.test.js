/** pullboard test names a failure main already has, per file, on a pulled run [C7]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { focusedProject as focused } from '../../../tests/fixtures/test/focused.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The focused-runner project, its failing change committed on the builder worktree. */
const focusedProject = () => focused(e2e);

test('pullboard test names a failure main already has, per file [C7]', async () => {
  const box = focusedProject();
  const ran = await box.runLocal(box.web, 'test', 'test/ok.test.js', 'test/hang.test.js', 'test/changed.test.js', '--json');
  const known = Object.fromEntries(JSON.parse(ran.out).known.map((entry) => [entry.file, entry.result]));
  assert.equal(known['test/hang.test.js'], 'red', 'the hang fails on main too, so it reads as a known main failure');
  assert.equal(known['test/changed.test.js'], 'green', 'the changed file passes on main, so its failure is new');
  assert.equal(known['test/ok.test.js'], undefined, 'a passing file needs no main comparison');
  const text = await box.runLocal(box.web, 'test', 'test/hang.test.js', '--compare-main');
  assert.equal(text.code, 1);
  assert.match(text.out.split('\n')[0], /file also fails on main at [a-f0-9]+: test\/hang\.test\.js \(case comparison unavailable\)/u, 'the first result line keeps the real file verdict without inventing a case match');
  assert.doesNotMatch(text.out, /not yours; accepted/u, 'a timeout is not an identical accepted case');
});
