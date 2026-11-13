import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { after } from 'node:test';
import { test } from 'node:test';
import { landingFailures } from '../../../../packages/landing/index.js';
import { landingSubject } from '../../../../packages/landing/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { startFixtureChild } from '../../tests/fixtures/child.js';
import { stopGroup } from '../../tests/fixtures/runner/group.js';
import { waitForFixtureProgress } from '../../tests/fixtures/progress.js';
import { json } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
/** Exercise landing diagnostics and bisect adoption against real private Git worktrees [B3,R3]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, BIN } = e2e;
const { FILES, landProject, verifiedFour } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('landing diagnostics retain unknown failures and merge subjects obey typed 72-character headers [B3,R3]', () => {
  const root = '/private/landing';
  const failures = landingFailures(`not ok 1 - located failure\n  location: ${root}/test/one.test.js:3:4\nnot ok 2 - unknown failure\n`, root);
  assert.deepEqual(failures, [{ name: 'located failure', file: 'test/one.test.js' }, { name: 'unknown failure', file: null }]);
  // Node 24 node --test reports with spec by default: its failing-tests summary names each file and test (#1071).
  const spec = landingFailures(`\u2716 red one (1.2ms)\n\u2716 failing tests:\n\ntest at web/red.test.js:6:1\n\u2716 red one (1.2ms)\n  AssertionError\n\ntest at /elsewhere/x.test.js:1:1\n\u2716 outside (3ms)\n`, root);
  assert.deepEqual(spec, [{ name: 'red one', file: 'web/red.test.js', assertion: 'AssertionError' }, { name: 'outside', file: null }], 'spec failures keep their file and assertion, and an outside path is unknown');
  // The title keeps priority up to the room its first row needs; the rows fill what is left (RFC 0005).
  const subject = landingSubject({ item_id: 91, item_title: 'A VERY LONG TITLE '.repeat(10), item_spec_ids: 'B3,R3' });
  assert.equal(subject, 'chore(merge): a very long title a very long title a very long [B3,R3]');
  assert.ok(subject.length <= 72);
});

test('land bisect adoption retains completed gates, isolated diagnostics and original candidates [B3,R3]', async (t) => {
  const box = landProject();
  const entries = verifiedFour(box, { red: 2 });
  writeFileSync(box.trace, '');
  writeFileSync(box.hold, '3');
  const child = startFixtureChild(process.execPath, [BIN, 'land', '--json'], { cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let outputBytes = 0;
  child.stdout.on('data', part => { outputBytes += Buffer.byteLength(part); });
  child.stderr.on('data', part => { outputBytes += Buffer.byteLength(part); });
  const closed = new Promise((resolveClose) => child.once('close', (status, signal) => resolveClose({ status, signal })));
  t.after(async () => {
    writeFileSync(box.release, 'release');
    await stopGroup(child, closed);
  });
  await waitForFixtureProgress({
    child,
    ready: () => existsSync(box.entered),
    progress: () => outputBytes + [box.calls, box.trace].reduce((bytes, file) =>
      bytes + (existsSync(file) ? readFileSync(file).length : 0), 0),
    description: 'third full gate inside bisection',
  });
  const interrupted = json(box, box.repo, 'resume').landingBatches.at(-1);
  assert.equal(interrupted.items.length, 2, 'the current half differs from the original four candidates');
  assert.equal(interrupted.gateResults.length, 2);
  assert.deepEqual(interrupted.diagnostics, [{ test: FILES[2], isGreen: false }]);
  process.kill(-child.pid, 'SIGKILL');
  assert.equal((await closed).signal, 'SIGKILL');
  writeFileSync(box.release, 'release');
  const result = json(box, box.repo, 'land', '--adopt');
  assert.deepEqual(result.landed, [entries[0].item, entries[1].item, entries[3].item]);
  const trace = readFileSync(box.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(trace.filter((row) => !row.alone && row.files.length === 4).length, 1, 'completed initial red is not retried');
  assert.equal(trace.filter((row) => !row.alone && row.files.join(',') === FILES.slice(0, 2).join(',')).length, 1, 'completed green half is not retried');
  assert.equal(trace.filter((row) => row.alone && row.files[0] === FILES[2]).length, 1, 'the isolated red is not retried');
  assert.equal(json(box, box.repo, 'show', String(entries[2].item)).thread.filter((entry) => entry.type === 'fact').length, 1);
});
