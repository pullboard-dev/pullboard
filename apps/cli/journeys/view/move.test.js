/** @pullboard-test-gui */
/** A live view keeps serving when a landing removes a shipped dependency [N26]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import {
  machine,
  project,
} from '../../tests/fixtures/cockpit/harness.js';

/** Wait for this exact native CLI child to publish its private view link. */
function ready(child) {
  return new Promise((resolveReady, reject) => {
    let output = '';
    // Budget: ordinary fixture startup, not the separate two-second large-board performance bar.
    const timer = setTimeout(() => finish(new Error('view did not publish its ready link')), 15_000);
    /** Remove every owned listener on either startup outcome. */
    function finish(error, link) {
      clearTimeout(timer);
      child.stdout.off('data', data);
      child.off('exit', exited);
      if (error) reject(error); else resolveReady(link);
    }
    /** Observe the native ready line without exposing the private credential in diagnostics. */
    function data(part) {
      output += part;
      const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/u.exec(output);
      if (match) finish(null, new URL(match[1]));
    }
    /** Refuse early process exit rather than treating it as an answered request. */
    function exited(code) { finish(new Error(`view exited before ready (${code})`)); }
    child.stdout.on('data', data);
    child.once('exit', exited);
  });
}

test('a running view answers state after its shipped doctrine dependency is removed [N26]', async () => {
  const box = machine(), demo = project(box, 'moving-source');
  const installed = join(box.dir, 'installed');
  mkdirSync(installed);
  copyPackageFiles(resolve(import.meta.dirname, '../../../..'), installed);
  const child = spawn(process.execPath, [join(installed, 'apps/cli/pullboard.js'), 'view', '--no-open', '--port', '0'], {
    cwd: demo.repo, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const link = await ready(child);
    const headers = { 'x-pullboard-key': link.searchParams.get('k') };
    /** Read this fixture's real HTTP API with bounded transport time. */
    const read = path => fetch(link.origin + path, { headers,
      signal: AbortSignal.timeout(10_000) }); // budget: a loopback request may fail; it must not leave the test waiting forever.
    const listing = await read('/api/v1/boards');
    assert.equal(listing.status, 200);
    const board = (await listing.json()).boards.find(entry => entry.root === demo.repo);
    assert.ok(board, 'the fixture project is served by the copied installed CLI');
    const path = `/api/v1/boards/${board.id}/state`;
    const before = await read(path);
    assert.equal(before.status, 200, 'the original source answers a real state request');
    const original = (await before.json()).state;
    // The shipped standard doctrine lives in its cell; a running generation must keep serving when a landing removes it.
    rmSync(join(installed, 'packages/doctrine/src/io/standard.md'));
    // A genuine watched board input change forces projection rather than reusing serialized state.
    appendFileSync(join(demo.repo, 'SPEC.md'), '\n');
    const after = await read(path + '?seen=0');
    const reply = await after.json();
    assert.equal(after.status, 200, `a source landing must not strand open pages (${reply.error?.code ?? 'no error'})`);
    assert.equal(reply.state.board, original.board);
    assert.deepEqual(reply.state.spec, original.spec);
    assert.deepEqual(reply.state.practice, original.practice, 'the running generation retains its shipped doctrine');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});
