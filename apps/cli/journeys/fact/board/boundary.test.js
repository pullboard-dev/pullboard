/** Real HTTP and hook boundaries use private projects and actual SQLite writer admission [B2,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { startFixtureChild } from '../../../tests/fixtures/child.js';
import { waitForFixtureProgress } from '../../../tests/fixtures/progress.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('the authenticated API answers without a long board writer hold [B2,C7]', async () => {
  const box = helpers.project('true');
  const trace = join(box.dir, 'api-lock-trace.jsonl');
  box.env.PULLBOARD_LOCK_BUDGET_TRACE = trace;
  box.env.PULLBOARD_LOCK_BUDGET_ENTRY = helpers.BIN;
  box.env.PULLBOARD_LOCK_BUDGET_COMMAND = 'api';
  const preload = fileURLToPath(new URL('../../../tests/fixtures/lock/hold/budget/preload.js', import.meta.url));
  const view = await helpers.startView(box, box.repo, { nodeArgs: ['--import', preload] });
  let start, end;
  try {
    start = Date.now();
    assert.ok((await view.state(box.repo)).project, 'a real authenticated HTTP request returns the project');
    end = Date.now();
  } finally { await view.stop(); }
  const rows = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.some(row => row.kind === 'runtime' && row.command === 'api'), 'the server observer actually ran');
  const holds = rows.filter(row => row.kind === 'hold' && row.command === 'api' && row.writeLockEvidence
    && row.acquiredAt <= end && row.releasedAt >= start);
  assert.ok(holds.every(row => row.heldMs < 1_000), 'no writer overlapping the API response exceeds one second'); // budget: the frozen #2282 API fixture requires no hold over one second.
});

test('a real pre-commit hook waiting on file I/O leaves the board writer available [B2,C7]', async () => {
  const box = helpers.project('true');
  const signal = join(box.dir, 'hook-io-entered');
  const release = join(box.dir, 'hook-io-release');
  const preload = join(box.dir, 'block-hook-read.mjs');
  writeFileSync(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    let blocked = false;
    fs.readFileSync = function(file, ...args) {
      if (!blocked && typeof file === 'string' && file.endsWith('/pullboard.json')) {
        blocked = true; fs.writeFileSync(process.env.HOOK_IO_SIGNAL, 'waiting');
        while (!fs.existsSync(process.env.HOOK_IO_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      return Reflect.apply(read, this, [file, ...args]);
    };
    syncBuiltinESMExports();
  `);
  const child = startFixtureChild(process.execPath, ['--import', preload, helpers.BIN, 'hook', 'pre-commit'], {
    cwd: box.web, env: { ...box.env, HOOK_IO_SIGNAL: signal, HOOK_IO_RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  const closed = once(child, 'close');
  try {
    await waitForFixtureProgress({ child, ready: () => existsSync(signal), progress: () => Number(existsSync(signal)),
      description: 'pre-commit hook reaches the delayed config read' });
    const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
    const peer = new DatabaseSync(file);
    try { peer.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK'); }
    finally { peer.close(); }
  } finally { writeFileSync(release, 'continue'); }
  const [status, signalCode] = await closed;
  assert.equal(signalCode, null, child.fixtureFailure);
  assert.equal(status, 0, child.fixtureFailure);
});
