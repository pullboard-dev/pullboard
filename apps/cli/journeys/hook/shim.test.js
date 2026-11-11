/** The commit hook shim times the whole hook from process start and stops a hook that runs past its limit [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { runHookShim } from '../../src/io/hook/shim.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The seat timing rows of one kind in a fixture repo's machine-local timing file. */
function hookRows(box, command) {
  const file = join(box.repo, '.git', 'pullboard', 'seat-timing.jsonl');
  const rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return rows.filter(row => row.kind === 'hook' && row.command === command);
}

test('a real commit writes start and end rows for each whole commit hook, timed from the shim process start [C7]', () => {
  const box = e2e.project('true');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  const before = Date.now();
  const result = e2e.commitFile(box, box.web, 'web/page.html', '<p>hi</p>\n', 'feat(web): one page [G1]');
  const done = Date.now();
  assert.equal(result.status, 0, result.stderr);
  for (const command of ['hook pre-commit', 'hook commit-msg']) {
    const rows = hookRows(box, command);
    const start = rows.find(row => row.phase === 'start');
    const end = rows.find(row => row.phase === 'end' && row.id === start?.id);
    assert.ok(start && end, `${command}: a start and an end row`);
    assert.equal(start.seat, 'web-1');
    assert.ok(before <= start.start && end.end <= done, `${command}: the rows sit inside the commit`);
    assert.equal(end.durationMs, end.end - start.start, `${command}: the duration runs from the shim's own start`);
    assert.equal(end.exit, 0);
    assert.equal(end.timedOut, false);
  }
});

test('a hook past its limit is stopped with its children, exits 1 and names a next step [C7]', async () => {
  const box = e2e.project('true');
  const pidFile = join(box.dir, 'grandchild.pid');
  const entry = join(box.dir, 'hanging-hook.mjs');
  writeFileSync(entry, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const chunks = [];
  const code = await runHookShim(entry, ['hook', 'pre-commit'], { cwd: box.web, env: box.env, stderr: { write: text => chunks.push(text) }, timeoutMs: 5000 });
  assert.equal(code, 1);
  const text = chunks.join('');
  assert.match(text, /\[HOOK_TIMEOUT\] the pre-commit hook ran past 5 s and was stopped/u);
  assert.match(text, /\nnext: commit again; if it stops again, run pullboard shout coordinator --kind blocker/u);
  // The grandchild was killed before the hook itself, whose exit settled the shim: it is gone or a zombie by now.
  const state = spawnSync('ps', ['-o', 'stat=', '-p', readFileSync(pidFile, 'utf8')], { encoding: 'utf8' }).stdout.trim();
  assert.ok(state === '' || state.startsWith('Z'), `the process the hook started is stopped too (ps stat: ${state})`);
  const end = hookRows(box, 'hook pre-commit').find(row => row.phase === 'end');
  assert.equal(end.timedOut, true);
  assert.equal(end.exit, 1);
});
