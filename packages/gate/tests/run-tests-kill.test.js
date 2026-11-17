/** A landing cleanup kill that hits a process the run no longer owns counts as gone, and says so [C7,#850]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { killAnsweredGone } from '../src/io/run-tests.js';

const OWNED = { pid: 4242, pgid: 4240, started: 'Mon Oct 20 03:00:00 2026', state: 'S' };

/** A kill failure with the errno code the kernel answered. */
function killError(code) { return Object.assign(new Error(`kill ${code}`), { code }); }

/** Run the decision while capturing what it writes to stderr. */
function decide(code, census) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { return { gone: killAnsweredGone(killError(code), OWNED, () => census), lines }; }
  finally { process.stderr.write = write; }
}

test('gate.run-tests-kill.eperm-pid-exited-was-reused: an EPERM for a pid that exited or was reused counts as gone and is logged [C7]', () => {
  for (const [why, census] of [
    ['exited', new Map()],
    ['reused by another process', new Map([[OWNED.pid, { ...OWNED, started: 'Mon Oct 20 03:00:07 2026' }]])],
    ['left as a zombie', new Map([[OWNED.pid, { ...OWNED, state: 'Z' }]])],
  ]) {
    const { gone, lines } = decide('EPERM', census);
    assert.equal(gone, true, `a process that ${why} is gone`);
    assert.match(lines.join(''), /run-tests: kill 4242 answered EPERM; that process is gone or no longer ours, so it counts as gone/u, why);
  }
});

test('gate.run-tests-kill.esrch-counts-gone-logged: an ESRCH counts as gone and is logged [C7]', () => {
  const { gone, lines } = decide('ESRCH', new Map([[OWNED.pid, OWNED]]));
  assert.equal(gone, true);
  assert.match(lines.join(''), /kill 4242 answered ESRCH/u);
});

test('gate.run-tests-kill.eperm-process-still-ours-real: an EPERM for a process that is still ours is a real permission error [C7]', () => {
  const { gone, lines } = decide('EPERM', new Map([[OWNED.pid, { ...OWNED }]]));
  assert.equal(gone, false, 'the caller keeps it as a cleanup error');
  assert.deepEqual(lines, [], 'and nothing claims it is gone');
});

test('gate.run-tests-kill.eperm-census-leaves-verdict-next: an EPERM with no census leaves the verdict to the next sweep, without claiming it is gone [C7]', () => {
  const { gone, lines } = decide('EPERM', null);
  assert.equal(gone, true, 'the sweep retries rather than failing the run');
  assert.deepEqual(lines, []);
});

test('gate.run-tests-kill.any-other-kill-failure-counted: any other kill failure is never counted as gone [C7]', () => {
  assert.equal(decide('EINVAL', new Map()).gone, false);
});
